// Creating a session: one call to the serve, registered with the catalog, and holding whatever
// rules it was created with from that call on. Split from the backend's main suite, which covers
// sessions already open; this needs no projection, only a serve that answers a create.

import { expect, test } from "bun:test";
import type { OpencodeClient } from "@/agents/opencode/opencodeClient";
import { OpencodeAgentBackend } from "@/agents/opencode/opencodeAgentBackend";

type CreateInput = { location?: { directory?: string }; permissions?: readonly unknown[] };

/** A serve that answers a create, storing the rules it was sent unless told to drop them. */
function backendOver(
  calls: CreateInput[],
  options: { created?: { sessionId: string; projectPath: string }[]; dropsRules?: boolean; removed?: string[] } = {},
) {
  const client = {
    session: {
      create: async (input: CreateInput) => {
        calls.push(input);
        return { id: "s-new", title: "New", ...(options.dropsRules ? {} : { permissions: input.permissions }) };
      },
      remove: async (input: { sessionID: string }) => void options.removed?.push(input.sessionID),
    },
  };
  return new OpencodeAgentBackend({
    resolveSession: () => undefined,
    onSessionCreated: (location) => options.created?.push(location),
    onCatalogChanged() {},
    client: () => client as unknown as OpencodeClient,
    now: () => 1000,
  });
}

const RULES = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
];

test("creating a session registers it through the serve", async () => {
  const calls: CreateInput[] = [];
  const created: { sessionId: string; projectPath: string }[] = [];
  const backend = backendOver(calls, { created });
  const descriptor = await backend.createSession("r1", "/repo");
  expect(descriptor).toMatchObject({ sessionId: "s-new", source: "opencode", projectPath: "/repo" });
  expect(created).toEqual([{ sessionId: "s-new", projectPath: "/repo" }]);
  expect(calls).toEqual([{ location: { directory: "/repo" } }]);
  await backend.dispose();
});

test("a session created with rules holds them from the create request itself", async () => {
  const calls: CreateInput[] = [];
  const backend = backendOver(calls);
  await backend.createSession("r1", "/repo", { permissions: RULES });
  expect(calls).toEqual([{ location: { directory: "/repo" }, permissions: RULES }]);
  await backend.dispose();
});

test("a session the serve made without its rules is removed, and the create fails", async () => {
  const removed: string[] = [];
  const created: { sessionId: string; projectPath: string }[] = [];
  const backend = backendOver([], { dropsRules: true, removed, created });
  await expect(backend.createSession("r1", "/repo", { permissions: RULES })).rejects.toThrow("without the rules");
  expect(removed).toEqual(["s-new"]);
  expect(created).toEqual([]);
  await backend.dispose();
});
