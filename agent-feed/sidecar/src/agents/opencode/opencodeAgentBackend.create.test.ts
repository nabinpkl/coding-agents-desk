// Creating a session: one call to the serve, registered with the catalog, and holding whatever
// rules it was created with from that call on. Split from the backend's main suite, which covers
// sessions already open; this needs no projection, only a serve that answers a create.

import { expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpencodeAgentBackend } from "@/agents/opencode/opencodeAgentBackend";

/** The create parameters as the SDK's builder receives them, which is what reaches the serve. */
type CreateParameters = { location?: { directory?: string }; $body_permissions?: unknown[] };

function backendOver(calls: CreateParameters[], created: { sessionId: string; projectPath: string }[] = []) {
  const client = {
    v2: {
      session: {
        create: async (params: CreateParameters) => {
          calls.push(params);
          return { data: { data: { id: "s-new", title: "New" } } };
        },
      },
    },
  };
  return new OpencodeAgentBackend({
    resolveSession: () => undefined,
    onSessionCreated: (location) => created.push(location),
    onCatalogChanged() {},
    client: () => client as unknown as OpencodeClient,
    now: () => 1000,
  });
}

test("creating a session registers it through the serve", async () => {
  const calls: CreateParameters[] = [];
  const created: { sessionId: string; projectPath: string }[] = [];
  const backend = backendOver(calls, created);
  const descriptor = await backend.createSession("r1", "/repo");
  expect(descriptor).toMatchObject({ sessionId: "s-new", source: "opencode", projectPath: "/repo" });
  expect(created).toEqual([{ sessionId: "s-new", projectPath: "/repo" }]);
  expect(calls).toEqual([{ location: { directory: "/repo" } }]);
  await backend.dispose();
});

test("a session created with rules holds them from the create request itself", async () => {
  const calls: CreateParameters[] = [];
  const backend = backendOver(calls);
  const permissions = [{ action: "*", resource: "*", effect: "deny" as const }];
  await backend.createSession("r1", "/repo", { permissions });
  // The SDK's builder sends only the body keys it knows, plus any spelled `$body_<name>`.
  expect(calls).toEqual([{ location: { directory: "/repo" }, $body_permissions: permissions }]);
  await backend.dispose();
});
