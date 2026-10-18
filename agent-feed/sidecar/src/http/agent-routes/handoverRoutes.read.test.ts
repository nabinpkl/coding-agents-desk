// Reading a session's handover -- its summary and the turns since -- without starting anything.
// Split from the handover routes' main suite, which covers the handovers that start a session.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import {
  createHandoverRoutes,
  LIVE_HANDOVER_ACTIONS,
  type HandoverRouteActions,
} from "@/http/agent-routes/handoverRoutes";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createHandoverRoutes>>[2];

function fakeBackend(): AgentBackend {
  return {
    id: "pi",
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: true,
      canStreamLive: false,
    },
    describeSession() {
      return undefined;
    },
    async createSession() {
      throw new Error("not used");
    },
    async page() {
      return {
        events: [],
        total: 0,
        mode: "nice" as const,
        sequence: 0,
        runState: "idle" as const,
        queue: { steer: 0, followUp: 0 },
      };
    },
    async subscribe() {
      return () => {};
    },
    async send(_sessionId, requestId, _text, delivery) {
      return { requestId, delivery: delivery === "steer" ? ("steer" as const) : ("immediate" as const) };
    },
    async abort(_sessionId, requestId) {
      return { requestId, delivery: "abort" as const };
    },
    async subscribeUi() {
      return () => {};
    },
    async respondToUi() {
      return "already-resolved" as const;
    },
    async dispose() {},
  };
}

/**
 * The handover creates an opencode session and sends the rendered context as its first prompt.
 * Real catalog state plus a real temp transcript, because the route's job is the wiring between
 * the two: the render itself is `sessionHandover.test.ts`'s. Nothing here replaces a module.
 */
const HANDOVER_ID = "44444444-4444-4444-8444-444444444444";

const HANDOVER_PLAIN_ID = "55555555-5555-4555-8555-555555555555";

function handoverLine(record: Record<string, unknown>): string {
  return JSON.stringify({
    cwd: "/tmp/project",
    timestamp: "2026-09-09T05:00:00.000Z",
    uuid: crypto.randomUUID(),
    ...record,
  });
}

/** `empty` has records but no turn in any of them: the one session left with nothing to hand over. */
async function handoverTranscript(id: string, shape: "compacted" | "plain" | "empty"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-handover-"));
  const path = join(root, `${id}.jsonl`);
  const lines = {
    compacted: [
      handoverLine({ type: "user", message: { role: "user", content: "before" } }),
      handoverLine({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      handoverLine({
        type: "user",
        isCompactSummary: true,
        message: { role: "user", content: "Primary request: fix it." },
      }),
      handoverLine({ type: "user", message: { role: "user", content: "did it land?" } }),
    ],
    plain: [handoverLine({ type: "user", message: { role: "user", content: "never summarized" } })],
    empty: [handoverLine({ type: "permission-mode", permissionMode: "default" })],
  }[shape];
  await writeFile(path, `${lines.join("\n")}\n`);
  return root;
}

function seedHandoverSession(id: string, transcriptPath: string): void {
  state.sessions.set(sessionKey("claude", id), {
    sessionId: id,
    source: "claude",
    project: "/tmp/project",
    transcriptPath,
    lastEventAt: Date.now(),
  });
}

function unseedHandoverSession(id: string, root: string): Promise<void> {
  state.sessions.delete(sessionKey("claude", id));
  return rm(root, { recursive: true, force: true });
}

function handoverBackend(calls: {
  created: { requestId: string; project: string }[];
  sent: { sessionId: string; text: string }[];
}): AgentBackend {
  const base = fakeBackend();
  const backend: AgentBackend = {
    ...base,
    id: "opencode",
    createSession: async (requestId: string, projectPath: string): Promise<AgentSessionDescriptor> => {
      calls.created.push({ requestId, project: projectPath });
      return {
        sessionId: "opencode-new",
        source: "opencode",
        projectPath,
        title: "new",
        lastEventAt: Date.now(),
        activity: "ready",
        capabilities: base.capabilities,
      };
    },
    send: async (sessionId: string, requestId: string, text: string, _delivery: "next" | "steer") => {
      calls.sent.push({ sessionId, text });
      return { requestId, delivery: "followUp" as const };
    },
  };
  return backend;
}

/**
 * The reverse direction. What it has to get right is not the render -- that is
 * `opencodeHandover.test.ts`'s -- but the wiring either side of it: that the successor lands in
 * the source's own directory, that the reader's message rides last, and that nothing is started
 * when the render refuses or the result is too large to put on a command line.
 */
const OPENCODE_ID = "oc_66666666";

function seedOpencodeSession(id: string, title?: string): void {
  state.sessions.set(sessionKey("opencode", id), {
    sessionId: id,
    source: "opencode",
    project: "/tmp/project",
    lastEventAt: Date.now(),
    ...(title === undefined ? {} : { title }),
  });
}

function unseedOpencodeSession(id: string): void {
  state.sessions.delete(sessionKey("opencode", id));
}

/** Records what would have been started, and starts nothing. */
function recordingLauncher(started: { cwd: string; title: string; prompt?: string }[]): SessionLauncher {
  return {
    async start(options) {
      started.push({
        cwd: options.cwd,
        title: options.title,
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      });
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

function claudeActions(
  started: { cwd: string; title: string; prompt?: string }[],
  renderOpencode: HandoverRouteActions["renderOpencode"],
): HandoverRouteActions {
  return { ...LIVE_HANDOVER_ACTIONS, launch: recordingLauncher(started), renderOpencode };
}

/**
 * Reading a session's handover without starting anything.
 *
 * The property worth pinning is not the JSON, it is that this and the two POSTs answer the same
 * question: a session the read offers a summary for is one a handover can be started from, and a
 * session it refuses is refused by the POST with the same code. Three routes disagreeing is a
 * caller that reads a summary and then cannot act on it.
 */
function readRequest(source: string, sessionId: string): Request {
  return new Request(`http://localhost/api/sessions/${source}/${sessionId}/handover`, { method: "GET" });
}

test("reads a Claude session's summary and the turns since it, and starts nothing", async () => {
  const root = await handoverTranscript(HANDOVER_ID, "compacted");
  seedHandoverSession(HANDOVER_ID, join(root, `${HANDOVER_ID}.jsonl`));
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  try {
    const route = createHandoverRoutes(
      () => undefined,
      claudeActions(started, async () => {
        throw new Error("the opencode reader is not this session's");
      }),
    );
    const request = readRequest("claude", HANDOVER_ID);
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      source: string;
      sessionId: string;
      project: string;
      summary: string;
      turns: string;
      turnCount: number;
      lossy: boolean;
    };
    expect(body).toMatchObject({
      source: "claude",
      sessionId: HANDOVER_ID,
      project: "/tmp/project",
      summary: "Primary request: fix it.",
      turnCount: 1,
      lossy: false,
    });
    expect(body.turns).toContain("did it land?");
    expect(body.turns).not.toContain("before");
    expect(started).toEqual([]);
  } finally {
    await unseedHandoverSession(HANDOVER_ID, root);
  }
});

test("reads an opencode session's summary through the serve", async () => {
  seedOpencodeSession(OPENCODE_ID, "Wire contract");
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  try {
    const route = createHandoverRoutes(
      () => undefined,
      claudeActions(started, async () => ({
        summary: "Primary request: fix the wire.",
        turns: "human: did it land?",
        turnCount: 1,
        lossy: true,
      })),
    );
    const request = readRequest("opencode", OPENCODE_ID);
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      source: "opencode",
      sessionId: OPENCODE_ID,
      title: "Wire contract",
      summary: "Primary request: fix the wire.",
      turnCount: 1,
      // Carried on the read as well as on the start, so a caller rendering this somewhere can say
      // that tool output was cut rather than presenting it as the whole record.
      lossy: true,
    });
    expect(started).toEqual([]);
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

test("refuses a source with no compaction boundary by name, not as a missing session", async () => {
  const route = createHandoverRoutes(() => undefined);
  const request = readRequest("codex", "cx-1");
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ error: { code: "unsupported-source" } });
});

test("the read and the start refuse the same session for the same reason", async () => {
  // The one thing three routes sharing a reader is FOR. A read that offers a summary the start
  // then refuses, or the other way round, is worse than either refusing alone.
  const root = await handoverTranscript(HANDOVER_PLAIN_ID, "empty");
  seedHandoverSession(HANDOVER_PLAIN_ID, join(root, `${HANDOVER_PLAIN_ID}.jsonl`));
  try {
    const route = createHandoverRoutes((id) =>
      id === "opencode" ? handoverBackend({ created: [], sent: [] }) : undefined,
    );

    const read = readRequest("claude", HANDOVER_PLAIN_ID);
    const readAnswer = await route(read, new URL(read.url), server);
    const start = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "r9", sessionId: HANDOVER_PLAIN_ID }),
    });
    const startAnswer = await route(start, new URL(start.url), server);

    expect(readAnswer?.status).toBe(startAnswer?.status);
    const [readBody, startBody] = await Promise.all([
      readAnswer?.json() as Promise<{ error: { code: string } }>,
      startAnswer?.json() as Promise<{ error: { code: string } }>,
    ]);
    expect(readBody.error.code).toBe("nothing-to-hand-over");
    expect(startBody.error.code).toBe("nothing-to-hand-over");
  } finally {
    await unseedHandoverSession(HANDOVER_PLAIN_ID, root);
  }
});

test("a session the catalog does not hold is 404 on the read too", async () => {
  const route = createHandoverRoutes(() => undefined);
  const request = readRequest("opencode", "oc_gone");
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(404);
  expect(await response?.json()).toMatchObject({ error: { code: "unknown-session" } });
});
