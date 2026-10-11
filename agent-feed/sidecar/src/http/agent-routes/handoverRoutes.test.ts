import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import {
  createHandoverRoutes,
  LIVE_HANDOVER_ACTIONS,
  MAX_HANDOVER_PROMPT,
  type HandoverRouteActions,
} from "@/http/agent-routes/handoverRoutes";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";
import { SessionHandoverError } from "@/transcripts/sessionHandover";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createHandoverRoutes>>[2];

function fakeBackend(): AgentBackend {
  return {
    id: "pi",
    capabilities: {
      modes: ["nice"], canSend: true, canSteer: true, canAbort: true,
      canFetchRaw: false, canOpenTerminal: false, supportsExtensionUi: true, canStreamLive: false,
    },
    describeSession() { return undefined; },
    async createSession() { throw new Error("not used"); },
    async page() {
      return { events: [], total: 0, mode: "nice" as const, sequence: 0, runState: "idle" as const, queue: { steer: 0, followUp: 0 } };
    },
    async subscribe() { return () => {}; },
    async send(_sessionId, requestId, _text, delivery) {
      return { requestId, delivery: delivery === "steer" ? "steer" as const : "immediate" as const };
    },
    async abort(_sessionId, requestId) { return { requestId, delivery: "abort" as const }; },
    async subscribeUi() { return () => {}; },
    async respondToUi() { return "already-resolved" as const; },
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
  return JSON.stringify({ cwd: "/tmp/project", timestamp: "2026-09-09T05:00:00.000Z", uuid: crypto.randomUUID(), ...record });
}

/** `empty` has records but no turn in any of them: the one session left with nothing to hand over. */
async function handoverTranscript(id: string, shape: "compacted" | "plain" | "empty"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-handover-"));
  const path = join(root, `${id}.jsonl`);
  const lines = {
    compacted: [
      handoverLine({ type: "user", message: { role: "user", content: "before" } }),
      handoverLine({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      handoverLine({ type: "user", isCompactSummary: true, message: { role: "user", content: "Primary request: fix it." } }),
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

function handoverBackend(calls: { created: { requestId: string; project: string }[]; sent: { sessionId: string; text: string }[] }): AgentBackend {
  const base = fakeBackend();
  const backend: AgentBackend = {
    ...base,
    id: "opencode",
    createSession: async (requestId: string, projectPath: string): Promise<AgentSessionDescriptor> => {
      calls.created.push({ requestId, project: projectPath });
      return { sessionId: "opencode-new", source: "opencode", projectPath, title: "new", lastEventAt: Date.now(), activity: "ready", capabilities: base.capabilities };
    },
    send: async (sessionId: string, requestId: string, text: string, _delivery: "next" | "steer") => {
      calls.sent.push({ sessionId, text });
      return { requestId, delivery: "followUp" as const };
    },
  };
  return backend;
}

test("a handover creates the opencode session in the source project and sends provenance plus context", async () => {
  const root = await handoverTranscript(HANDOVER_ID, "compacted");
  seedHandoverSession(HANDOVER_ID, join(root, `${HANDOVER_ID}.jsonl`));
  try {
    const calls = { created: [] as { requestId: string; project: string }[], sent: [] as { sessionId: string; text: string }[] };
    const route = createHandoverRoutes((id) => id === "opencode" ? handoverBackend(calls) : undefined);
    const request = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "h1", sessionId: HANDOVER_ID, message: "go on" }),
    });
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(201);
    const body = await response?.json() as { session: { sessionId: string }; handover: { turnCount: number } };
    expect(body.session.sessionId).toBe("opencode-new");
    expect(calls.created).toEqual([{ requestId: "h1-create", project: "/tmp/project" }]);
    expect(calls.sent).toHaveLength(1);
    const prompt = calls.sent[0]!.text;
    expect(prompt.startsWith("This was obtained from an earlier session from another agent")).toBe(true);
    expect(prompt).toContain("Primary request: fix it.");
    expect(prompt).toContain("did it land?");
    expect(prompt).not.toContain("before");
    expect(prompt.endsWith("go on\n")).toBe(true);
  } finally {
    await unseedHandoverSession(HANDOVER_ID, root);
  }
});

test("a handover answers 404 for an unknown session", async () => {
  const route = createHandoverRoutes(() => fakeBackend());
  const missing = new Request("http://localhost/api/agent-sessions/opencode/handover", {
    method: "POST",
    body: JSON.stringify({ requestId: "h2", sessionId: "no-such-session" }),
  });
  expect((await route(missing, new URL(missing.url), server))?.status).toBe(404);
});

test("a session that never compacted hands over its whole conversation", async () => {
  // A compaction was never what made a handover small enough: the render cuts every tool input
  // and output to head and tail either way. Refusing here sent a reader off to compact a session
  // just to move it.
  const root = await handoverTranscript(HANDOVER_PLAIN_ID, "plain");
  seedHandoverSession(HANDOVER_PLAIN_ID, join(root, `${HANDOVER_PLAIN_ID}.jsonl`));
  try {
    const calls = { created: [] as { requestId: string; project: string }[], sent: [] as { sessionId: string; text: string }[] };
    const route = createHandoverRoutes((id) => id === "opencode" ? handoverBackend(calls) : undefined);
    const plain = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "h3", sessionId: HANDOVER_PLAIN_ID }),
    });
    const response = await route(plain, new URL(plain.url), server);
    expect(response?.status).toBe(201);
    const prompt = calls.sent[0]!.text;
    expect(prompt).toContain("never compacted");
    expect(prompt).toContain("never summarized");
    expect(prompt).not.toContain("COMPACTION SUMMARY");
  } finally {
    await unseedHandoverSession(HANDOVER_PLAIN_ID, root);
  }
});

test("a handover answers 404 when opencode is not registered", async () => {
  const root = await handoverTranscript(HANDOVER_ID, "compacted");
  seedHandoverSession(HANDOVER_ID, join(root, `${HANDOVER_ID}.jsonl`));
  try {
    const route = createHandoverRoutes(() => undefined);
    const request = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "h4", sessionId: HANDOVER_ID }),
    });
    expect((await route(request, new URL(request.url), server))?.status).toBe(404);
  } finally {
    await unseedHandoverSession(HANDOVER_ID, root);
  }
});

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
      started.push({ cwd: options.cwd, title: options.title, ...(options.prompt === undefined ? {} : { prompt: options.prompt }) });
      return { tmuxSession: `agentdesk-${options.sessionId}` };
    },
    async fork() { throw new Error("a handover never forks"); },
    async end() { return null; },
  };
}

function claudeActions(
  started: { cwd: string; title: string; prompt?: string }[],
  renderOpencode: HandoverRouteActions["renderOpencode"],
): HandoverRouteActions {
  return { ...LIVE_HANDOVER_ACTIONS, launch: recordingLauncher(started), renderOpencode };
}

function handoverRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agent-sessions/claude/handover", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("a handover to Claude starts a session where the opencode session runs, carrying its context", async () => {
  seedOpencodeSession(OPENCODE_ID, "Wire contract");
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  try {
    const route = createHandoverRoutes(() => undefined, claudeActions(started, async () => ({
      summary: "Primary request: fix the wire.",
      turns: "human: did it land?",
      turnCount: 1,
      lossy: false,
    })));
    const request = handoverRequest({ requestId: "r1", sessionId: OPENCODE_ID, message: "go on" });
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(201);
    const body = await response?.json() as { session: { title: string; projectPath: string }; handover: { chars: number } };
    expect(body.session.title).toBe("Wire contract (handover)");
    expect(body.session.projectPath).toBe("/tmp/project");
    expect(started).toHaveLength(1);
    expect(started[0]!.cwd).toBe("/tmp/project");
    const prompt = started[0]!.prompt!;
    expect(prompt.startsWith("This was obtained from an earlier session from another agent (opencode,")).toBe(true);
    expect(prompt).toContain("Primary request: fix the wire.");
    expect(prompt).toContain("did it land?");
    // Last, where an instruction gets the model's attention rather than being buried under the
    // history above it. The forward direction pins the same thing for the same reason.
    expect(prompt.endsWith("go on\n")).toBe(true);
    expect(body.handover.chars).toBe(prompt.length);
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

test("a handover to Claude puts the started session on the asking Bot, in the same request", async () => {
  // The panel's own attach resolved against the catalog, which has no Claude session until its
  // first turn writes the transcript, so it failed every time with "not in the current catalog".
  seedOpencodeSession(OPENCODE_ID, "Wire contract");
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  const attached: { botId: string; sessionId: string }[] = [];
  try {
    const route = createHandoverRoutes(() => undefined, {
      ...claudeActions(started, async () => ({ summary: null, turns: "human: hi", turnCount: 1, lossy: false })),
      bots: {
        exists: async (botId) => botId === "bot-1",
        attach: async (botId, ref) => { attached.push({ botId, sessionId: ref.sessionId }); },
      },
    });
    const request = handoverRequest({ requestId: "r7", sessionId: OPENCODE_ID, botId: "bot-1" });
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(201);
    const body = await response?.json() as { session: { sessionId: string } };
    expect(attached).toEqual([{ botId: "bot-1", sessionId: body.session.sessionId }]);

    // A Bot that is gone is refused before anything starts, rather than leaving a pane behind.
    const stale = handoverRequest({ requestId: "r8", sessionId: OPENCODE_ID, botId: "bot-gone" });
    const refused = await route(stale, new URL(stale.url), server);
    expect(refused?.status).toBe(404);
    expect(await refused?.json()).toMatchObject({ error: { code: "unknown-bot" } });
    expect(started).toHaveLength(1);
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

test("a handover to Claude answers 404 for an unknown session and for one with nothing in it", async () => {
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  const refusing = createHandoverRoutes(() => undefined, claudeActions(started, async () => {
    throw new SessionHandoverError("has no conversation to hand over");
  }));

  const missing = handoverRequest({ requestId: "r2", sessionId: "oc_nothing" });
  expect((await refusing(missing, new URL(missing.url), server))?.status).toBe(404);

  seedOpencodeSession(OPENCODE_ID);
  try {
    const plain = handoverRequest({ requestId: "r3", sessionId: OPENCODE_ID });
    const response = await refusing(plain, new URL(plain.url), server);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ error: { code: "nothing-to-hand-over" } });
    // The refusal is the whole point: a session that was started and then told nothing is worse
    // than no session, because it looks like the handover worked.
    expect(started).toEqual([]);
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

test("a handover past the command-line cap is refused rather than handed to the kernel", async () => {
  seedOpencodeSession(OPENCODE_ID);
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  try {
    const route = createHandoverRoutes(() => undefined, claudeActions(started, async () => ({
      summary: "x".repeat(MAX_HANDOVER_PROMPT + 1),
      turns: "",
      turnCount: 0,
      lossy: false,
    })));
    const request = handoverRequest({ requestId: "r4", sessionId: OPENCODE_ID });
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(413);
    expect(await response?.json()).toMatchObject({ error: { code: "handover-too-large" } });
    expect(started).toEqual([]);
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

test("a session with no title of its own still gets a title that is one", async () => {
  seedOpencodeSession(OPENCODE_ID);
  const started: { cwd: string; title: string; prompt?: string }[] = [];
  try {
    const route = createHandoverRoutes(() => undefined, claudeActions(started, async () => ({
      summary: "summary", turns: "", turnCount: 0, lossy: false,
    })));
    const request = handoverRequest({ requestId: "r5", sessionId: OPENCODE_ID });
    expect((await route(request, new URL(request.url), server))?.status).toBe(201);
    // `-n` takes this to the Claude CLI's command line, so an empty one is not a cosmetic gap.
    expect(started[0]!.title).toBe("opencode session (handover)");
  } finally {
    unseedOpencodeSession(OPENCODE_ID);
  }
});

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
    const route = createHandoverRoutes(() => undefined, claudeActions(started, async () => {
      throw new Error("the opencode reader is not this session's");
    }));
    const request = readRequest("claude", HANDOVER_ID);
    const response = await route(request, new URL(request.url), server);
    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      source: string; sessionId: string; project: string;
      summary: string; turns: string; turnCount: number; lossy: boolean;
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
    const route = createHandoverRoutes(() => undefined, claudeActions(started, async () => ({
      summary: "Primary request: fix the wire.",
      turns: "human: did it land?",
      turnCount: 1,
      lossy: true,
    })));
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
    const route = createHandoverRoutes((id) => id === "opencode"
      ? handoverBackend({ created: [], sent: [] })
      : undefined);

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
