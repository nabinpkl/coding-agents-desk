// What a handover names its successor, in both directions, and how it marks it as one on the Bots.
// To opencode, the name has to be on before the first prompt; to Claude on a Bot, the successor
// starts under the anchor the Bot spends for it. Split from the handover routes' main suite, which
// covers what the handovers send.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import { createHandoverRoutes, LIVE_HANDOVER_ACTIONS, type HandoverBots } from "@/http/agent-routes/handoverRoutes";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createHandoverRoutes>>[2];
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const OPENCODE_SOURCE = "ses_naming_source";

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
  state.sessions.delete(sessionKey("opencode", OPENCODE_SOURCE));
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

async function handover(
  calls: string[],
  body: Record<string, unknown>,
  renameFails = false,
  bots?: HandoverBots,
): Promise<Response> {
  const route = createHandoverRoutes((id) => (id === "opencode" ? recordingBackend(calls, renameFails) : undefined), {
    ...LIVE_HANDOVER_ACTIONS,
    ...(bots ? { bots } : {}),
  });
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

/** A Bot holding the source, recording what the route asked of it in order. */
function recordingBots(calls: string[]): HandoverBots {
  return {
    exists: async (botId) => botId === "bot-1",
    attach: async () => {
      calls.push("attach");
    },
    carryLog: async () => {},
    recordOrigin: async (from, to) => {
      calls.push(`mark ${from.source} -> ${to.source}`);
    },
    reserveAnchor: async () => {
      calls.push("reserve");
      return "Gina";
    },
  };
}

test("a handover to opencode marks its successor as one on the Bots that hold its source", async () => {
  seedSource("Aaron (Lighthouse keeper who repairs clocks)");
  const calls: string[] = [];
  expect((await handover(calls, {}, false, recordingBots(calls))).status).toBe(201);
  expect(calls).toEqual(["create", "rename Lighthouse keeper who repairs clocks", "send", "mark claude -> opencode"]);
});

function seedOpencodeSource(title: string): void {
  state.sessions.set(sessionKey("opencode", OPENCODE_SOURCE), {
    sessionId: OPENCODE_SOURCE,
    source: "opencode",
    project: "/tmp/project",
    lastEventAt: Date.now(),
    title,
  });
}

/** Records the name each Claude successor would have started under, and starts nothing. */
function recordingLauncher(started: { title: string; unnamed: boolean }[]): SessionLauncher {
  return {
    async start(options) {
      started.push({ title: options.title, unnamed: options.unnamed === true });
      return { tmuxSession: `agentdesk-${options.sessionId}` };
    },
    async fork() {
      throw new Error("a handover never forks");
    },
    async end() {
      return null;
    },
  };
}

async function handoverToClaude(
  started: { title: string; unnamed: boolean }[],
  calls: string[],
  body: Record<string, unknown>,
): Promise<Response> {
  const route = createHandoverRoutes(() => undefined, {
    ...LIVE_HANDOVER_ACTIONS,
    launch: recordingLauncher(started),
    renderOpencode: async () => ({ summary: null, turns: "human: hi", turnCount: 1, lossy: false }),
    bots: recordingBots(calls),
  });
  const request = new Request("http://localhost/api/agent-sessions/claude/handover", {
    method: "POST",
    body: JSON.stringify({ requestId: "r1", sessionId: OPENCODE_SOURCE, botId: "bot-1", ...body }),
  });
  return (await route(request, new URL(request.url), server))!;
}

// It used to start as `Emma (How tide pools form) (handover)`, which the title queue, reading one
// bracket, then renamed `Gina (Emma)`.
test.each([
  ["its source's task", "Emma (How tide pools form)", undefined, "Gina (How tide pools form)", false],
  [
    "the requested task over the source's",
    "Emma (How tide pools form)",
    "Check the clocks",
    "Gina (Check the clocks)",
    false,
  ],
  ["no task, unnamed for Claude to title", "Emma", undefined, "Gina", true],
])(
  "a handover to Claude on a Bot starts under the Bot's next anchor with %s",
  async (_, source, title, named, unnamed) => {
    seedOpencodeSource(source);
    const started: { title: string; unnamed: boolean }[] = [];
    const calls: string[] = [];
    const response = await handoverToClaude(started, calls, title === undefined ? {} : { title });
    expect(response.status).toBe(201);
    expect(started).toEqual([{ title: named, unnamed }]);
    expect(calls).toEqual(["reserve", "attach", "mark opencode -> claude"]);
  },
);

test("a task requested for a Claude successor on a Bot that cannot bracket is refused before a name is spent", async () => {
  seedOpencodeSource("Emma (How tide pools form)");
  const started: { title: string; unnamed: boolean }[] = [];
  const calls: string[] = [];
  const response = await handoverToClaude(started, calls, { title: "Check (the) clocks" });
  expect(response.status).toBe(400);
  expect(started).toEqual([]);
  expect(calls).toEqual([]);
});
