// What a handover to opencode names its successor, and that the name is on before the first prompt.
// Split from the handover routes' main suite, which covers what the handovers send.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import { createHandoverRoutes } from "@/http/agent-routes/handoverRoutes";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createHandoverRoutes>>[2];
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-handover-naming-"));
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: "keep the clocks running" },
    cwd: "/tmp/project",
    timestamp: "2026-10-24T05:00:00.000Z",
    uuid: crypto.randomUUID(),
  });
  await writeFile(join(root, `${SOURCE_ID}.jsonl`), `${line}\n`);
});

afterEach(async () => {
  state.sessions.delete(sessionKey("claude", SOURCE_ID));
  await rm(root, { recursive: true, force: true });
});

function seedSource(title: string | undefined): void {
  state.sessions.set(sessionKey("claude", SOURCE_ID), {
    sessionId: SOURCE_ID,
    source: "claude",
    project: "/tmp/project",
    transcriptPath: join(root, `${SOURCE_ID}.jsonl`),
    lastEventAt: Date.now(),
    ...(title === undefined ? {} : { title }),
  });
}

/** The three calls a handover makes of the serve, in the order it made them. */
function recordingBackend(calls: string[], renameFails = false): AgentBackend {
  const backend = {
    id: "opencode",
    createSession: async (_requestId: string, projectPath: string): Promise<AgentSessionDescriptor> => {
      calls.push("create");
      return { sessionId: "opencode-new", source: "opencode", projectPath, title: "", lastEventAt: 1 } as never;
    },
    renameSession: async (_sessionId: string, title: string) => {
      if (renameFails) throw new Error("serve said no");
      calls.push(`rename ${title}`);
    },
    send: async (_sessionId: string, requestId: string) => {
      calls.push("send");
      return { requestId, delivery: "followUp" as const };
    },
  };
  return backend as unknown as AgentBackend;
}

async function handover(calls: string[], body: Record<string, unknown>, renameFails = false): Promise<Response> {
  const route = createHandoverRoutes((id) => (id === "opencode" ? recordingBackend(calls, renameFails) : undefined));
  const request = new Request("http://localhost/api/agent-sessions/opencode/handover", {
    method: "POST",
    body: JSON.stringify({ requestId: "h1", sessionId: SOURCE_ID, ...body }),
  });
  return (await route(request, new URL(request.url), server))!;
}

test.each([
  [
    "a Bot session's bracket",
    "Aaron (Lighthouse keeper who repairs clocks)",
    undefined,
    "Lighthouse keeper who repairs clocks",
  ],
  ["a plain title, less its old suffix", "Fix the login bug (fork 2)", undefined, "Fix the login bug"],
  [
    "the typed task over the source's",
    "Aaron (Lighthouse keeper who repairs clocks)",
    "Check the clocks",
    "Check the clocks",
  ],
  ["nothing for a source with no title of its own", undefined, undefined, null],
  ["nothing for a source wearing its bare anchor", "Gloria", undefined, null],
  ["nothing for a borrowed task that cannot bracket", "Fix (x) bug", undefined, null],
])("a handover names its successor by %s, before its first prompt", async (_, sourceTitle, task, named) => {
  seedSource(sourceTitle);
  const calls: string[] = [];
  const response = await handover(calls, task === undefined ? {} : { task });
  expect(response.status).toBe(201);
  expect(calls).toEqual(named === null ? ["create", "send"] : ["create", `rename ${named}`, "send"]);
  const answered = (await response.json()) as { session: { title: string } };
  expect(answered.session.title).toBe(named ?? "");
});

test("a typed task that cannot bracket is refused before anything is made", async () => {
  seedSource("Aaron (Lighthouse keeper who repairs clocks)");
  const calls: string[] = [];
  const response = await handover(calls, { task: "Check (the) clocks" });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
    "task: a session task cannot contain parentheses",
  );
  expect(calls).toEqual([]);
});

test("a successor the serve will not name is still handed over, for opencode to title", async () => {
  seedSource("Aaron (Lighthouse keeper who repairs clocks)");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const calls: string[] = [];
    const response = await handover(calls, {}, true);
    expect(response.status).toBe(201);
    expect(calls).toEqual(["create", "send"]);
    expect(((await response.json()) as { session: { title: string } }).session.title).toBe("");
    expect(logged).toHaveBeenCalledWith("Handover could not name the opencode session", expect.any(Error));
  } finally {
    logged.mockRestore();
  }
});
