import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import { createAgentRoutes } from "@/http/agentRoutes";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

function fakeBackend(): AgentBackend {
  return {
    id: "pi",
    capabilities: { modes: ["nice"], canSend: true, canSteer: true, canAbort: true, canFetchRaw: false, canOpenTerminal: false, supportsExtensionUi: true, canStreamLive: false },
    describeSession() { return undefined; },
    async createSession() { throw new Error("not used"); },
    async page() { return { events: [], total: 0, mode: "nice", sequence: 0, runState: "idle", queue: { steer: 0, followUp: 0 } }; },
    async subscribe() { return () => {}; },
    async send(sessionId, requestId, _text, delivery) { return { requestId, delivery: delivery === "steer" ? "steer" : "immediate" }; },
    async abort(_sessionId, requestId) { return { requestId, delivery: "abort" }; },
    async subscribeUi() { return () => {}; },
    async respondToUi() { return "accepted"; },
    async dispose() {},
  };
}

const server = { timeout() {} } as never;

test("message routes validate and return a correlated accepted receipt", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes((id) => id === "pi" ? backend : undefined);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r1", text: "hello", delivery: "next" }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "r1", delivery: "immediate" });
});

test("message routes carry image attachments to an opencode backend and refuse them elsewhere", async () => {
  const received: { attachments: unknown }[] = [];
  const base = fakeBackend();
  const route = createAgentRoutes((id) => {
    if (id !== "opencode" && id !== "pi") return undefined;
    return {
      ...base,
      id,
      send: async (sessionId: string, requestId: string, _text: string, delivery: "next" | "steer", attachments?: readonly unknown[]) => {
        received.push({ attachments });
        return { requestId, delivery: "followUp" as const };
      },
    };
  });
  const image = {
    method: "POST",
    body: JSON.stringify({
      requestId: "r-img",
      text: "look at this",
      delivery: "next",
      files: [{ data: Buffer.from("png-bytes").toString("base64"), mime: "image/png", name: "shot.png" }],
    }),
  };
  const accepted = new Request("http://localhost/api/agent-sessions/opencode/s1/messages", image);
  expect((await route(accepted, new URL(accepted.url), server))?.status).toBe(202);
  expect(received).toHaveLength(1);
  expect(received[0]!.attachments).toEqual([
    { data: Buffer.from("png-bytes").toString("base64"), mime: "image/png", name: "shot.png" },
  ]);

  const refused = new Request("http://localhost/api/agent-sessions/pi/s1/messages", image);
  const refusal = await route(refused, new URL(refused.url), server);
  expect(refusal?.status).toBe(400);
  expect(await refusal?.json()).toMatchObject({ error: { code: "unsupported-attachments" } });

  const badData = new Request("http://localhost/api/agent-sessions/opencode/s1/messages", {
    method: "POST",
    body: JSON.stringify({
      requestId: "r-bad",
      text: "look",
      delivery: "next",
      files: [{ data: "!!!", mime: "image/png", name: "shot.png" }],
    }),
  });
  const rejected = await route(badData, new URL(badData.url), server);
  expect(rejected?.status).toBe(400);
  expect(await rejected?.json()).toMatchObject({ error: { code: "invalid-attachments" } });
});

test("message routes reject empty and oversized prompts", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const empty = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r1", text: "  ", delivery: "next" }),
  });
  expect((await route(empty, new URL(empty.url), server))?.status).toBe(400);
  const huge = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r2", text: "x".repeat(256 * 1024 + 1), delivery: "next" }),
  });
  expect((await route(huge, new URL(huge.url), server))?.status).toBe(413);
});

test("Pi pages reject raw mode instead of silently renumbering", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/sessions/pi/s1/events?mode=raw");
  expect((await route(request, new URL(request.url), server))?.status).toBe(400);
});

test("extension UI responses are correlated through the backend broker", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: true }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "ui-1", delivery: "ui" });
});

test("extension UI rejects an invalid value without consuming the prompt", async () => {
  const backend = fakeBackend();
  backend.respondToUi = async () => "invalid";
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: "not-an-option" }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(422);
  expect(await response?.json()).toMatchObject({
    error: { code: "invalid-ui-response", requestId: "ui-1", retryable: false },
  });
});

test("extension UI acknowledges a valid answer that lost the viewer race", async () => {
  const backend = fakeBackend();
  backend.respondToUi = async () => "already-resolved";
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: true }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "ui-1", delivery: "ui-already-resolved" });
});

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

async function handoverTranscript(id: string, compacted: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-handover-"));
  const path = join(root, `${id}.jsonl`);
  const lines = compacted
    ? [
      handoverLine({ type: "user", message: { role: "user", content: "before" } }),
      handoverLine({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      handoverLine({ type: "user", isCompactSummary: true, message: { role: "user", content: "Primary request: fix it." } }),
      handoverLine({ type: "user", message: { role: "user", content: "did it land?" } }),
    ]
    : [handoverLine({ type: "user", message: { role: "user", content: "never summarized" } })];
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
  const root = await handoverTranscript(HANDOVER_ID, true);
  seedHandoverSession(HANDOVER_ID, join(root, `${HANDOVER_ID}.jsonl`));
  try {
    const calls = { created: [] as { requestId: string; project: string }[], sent: [] as { sessionId: string; text: string }[] };
    const route = createAgentRoutes((id) => id === "opencode" ? handoverBackend(calls) : undefined);
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

test("a handover answers 404 when the session is unknown or was never compacted", async () => {
  const route = createAgentRoutes(() => fakeBackend());
  const missing = new Request("http://localhost/api/agent-sessions/opencode/handover", {
    method: "POST",
    body: JSON.stringify({ requestId: "h2", sessionId: "no-such-session" }),
  });
  expect((await route(missing, new URL(missing.url), server))?.status).toBe(404);

  const root = await handoverTranscript(HANDOVER_PLAIN_ID, false);
  seedHandoverSession(HANDOVER_PLAIN_ID, join(root, `${HANDOVER_PLAIN_ID}.jsonl`));
  try {
    const plain = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "h3", sessionId: HANDOVER_PLAIN_ID }),
    });
    const response = await route(plain, new URL(plain.url), server);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ error: { code: "no-compaction-point" } });
  } finally {
    await unseedHandoverSession(HANDOVER_PLAIN_ID, root);
  }
});

test("a handover answers 404 when opencode is not registered", async () => {
  const root = await handoverTranscript(HANDOVER_ID, true);
  seedHandoverSession(HANDOVER_ID, join(root, `${HANDOVER_ID}.jsonl`));
  try {
    const route = createAgentRoutes(() => undefined);
    const request = new Request("http://localhost/api/agent-sessions/opencode/handover", {
      method: "POST",
      body: JSON.stringify({ requestId: "h4", sessionId: HANDOVER_ID }),
    });
    expect((await route(request, new URL(request.url), server))?.status).toBe(404);
  } finally {
    await unseedHandoverSession(HANDOVER_ID, root);
  }
});
