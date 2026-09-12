import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCommandConflictError,
  createPersistentPiSessionManager,
  PiAgentBackend,
  piProjectSessionDirectory,
  type PiRuntimeFacade,
  type PiSessionFacade,
} from "@/agents/piAgentBackend";

class FakeSession implements PiSessionFacade {
  sessionId = "session-1";
  sessionFile: string | undefined = "/tmp/session-1.jsonl";
  messages = [] as PiSessionFacade["messages"];
  isIdle = true;
  calls: string[] = [];
  aborted = 0;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  async prompt(text: string) { this.calls.push(`prompt:${text}`); this.isIdle = false; }
  async steer(text: string) { this.calls.push(`steer:${text}`); }
  async followUp(text: string) { this.calls.push(`followUp:${text}`); }
  async abort() { this.aborted += 1; this.isIdle = true; }
  subscribe(listener: (event: AgentSessionEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async bindExtensions() {}
  emit(event: AgentSessionEvent) { for (const listener of this.listeners) listener(event); }
}

class FakeRuntime implements PiRuntimeFacade {
  disposed = 0;
  constructor(readonly session: FakeSession) {}
  async dispose() { this.disposed += 1; }
}

function fixture(options: { idleRuntimeMs?: number; toolCallBudget?: number } = {}) {
  let starts = 0;
  let now = 100;
  const session = new FakeSession();
  const runtime = new FakeRuntime(session);
  const backend = new PiAgentBackend({
    resolveSession: (sessionId) => sessionId === "session-1" ? {
      sessionId,
      projectPath: "/tmp/project",
      transcriptPath: "/tmp/session-1.jsonl",
      title: "One",
      lastEventAt: 1,
    } : undefined,
    onSessionCreated() {},
    runtimeFactory: async () => { starts += 1; return runtime; },
    idleRuntimeMs: options.idleRuntimeMs ?? 1000,
    toolCallBudget: options.toolCallBudget ?? 64,
    now: () => now,
  });
  return { backend, session, runtime, starts: () => starts, setNow: (value: number) => { now = value; } };
}

test("concurrent viewers share one runtime and disconnect independently", async () => {
  const value = fixture();
  const [left, right] = await Promise.all([
    value.backend.subscribe("session-1", 0, () => {}),
    value.backend.subscribe("session-1", 0, () => {}),
  ]);
  expect(value.starts()).toBe(1);
  left();
  expect(value.runtime.disposed).toBe(0);
  right();
  await value.backend.dispose();
  expect(value.runtime.disposed).toBe(1);
});

test("session descriptors report backend-owned live activity", async () => {
  const value = fixture();
  expect(value.backend.describeSession("session-1")).toBeUndefined();
  await value.backend.send("session-1", "r1", "one", "next");
  value.session.emit({ type: "agent_start" });
  expect(value.backend.describeSession("session-1")?.activity).toBe("live");
  await value.backend.dispose();
});

test("run-state transitions invalidate session-list subscribers", async () => {
  let changes = 0;
  const session = new FakeSession();
  const runtime = new FakeRuntime(session);
  const backend = new PiAgentBackend({
    resolveSession: (sessionId) => ({
      sessionId,
      projectPath: "/tmp/project",
      transcriptPath: "/tmp/session-1.jsonl",
      title: "One",
      lastEventAt: 1,
    }),
    onSessionCreated() {},
    onSessionChanged() { changes += 1; },
    runtimeFactory: async () => runtime,
    idleRuntimeMs: 1000,
  });
  await backend.page("session-1", 0, 10, "nice");

  session.emit({ type: "agent_start" });
  session.emit({ type: "agent_settled" });

  expect(changes).toBe(2);
  await backend.dispose();
});

test("normal input prompts while idle then queues while active and steer stays explicit", async () => {
  const value = fixture();
  expect(await value.backend.send("session-1", "r1", "one", "next")).toMatchObject({ delivery: "immediate" });
  await Promise.resolve();
  expect(await value.backend.send("session-1", "r2", "two", "next")).toMatchObject({ delivery: "followUp" });
  expect(await value.backend.send("session-1", "r3", "three", "steer")).toMatchObject({ delivery: "steer" });
  expect(value.session.calls).toEqual(["prompt:one", "followUp:two", "steer:three"]);
  await value.backend.dispose();
});

test("request ids are idempotent and conflicting reuse fails", async () => {
  const value = fixture();
  const first = await value.backend.send("session-1", "same", "one", "next");
  const duplicate = await value.backend.send("session-1", "same", "one", "next");
  expect(duplicate).toEqual(first);
  expect(() => value.backend.send("session-1", "same", "other", "next")).toThrow(AgentCommandConflictError);
  await value.backend.dispose();
});

test("idle runtimes reap without deleting the persisted session", async () => {
  const value = fixture({ idleRuntimeMs: 10 });
  await value.backend.page("session-1", 0, 10, "nice");
  value.setNow(111);
  await value.backend.reapIdle();
  expect(value.runtime.disposed).toBe(1);
  expect(value.starts()).toBe(1);
  await value.backend.dispose();
});

test("a runaway tool loop aborts after the configured budget", async () => {
  const value = fixture({ toolCallBudget: 1 });
  await value.backend.page("session-1", 0, 10, "nice");
  value.session.emit({ type: "agent_start" });
  value.session.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
  value.session.emit({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: {} });
  await Promise.resolve();
  expect(value.session.aborted).toBe(1);
  await value.backend.dispose();
});

test("new persistent sessions use Pi's encoded project directory under the configured root", () => {
  expect(piProjectSessionDirectory("/tmp/project:one", "/tmp/pi-sessions"))
    .toBe("/tmp/pi-sessions/--tmp-project-one--");
});

test("new Pi session identity is durable before the first prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-pi-session-"));
  const project = join(root, "project");
  await mkdir(project);
  try {
    const manager = createPersistentPiSessionManager(project, join(root, "sessions"));
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const header = JSON.parse(await readFile(sessionFile!, "utf8"));
    expect(header).toMatchObject({
      type: "session",
      id: manager.getSessionId(),
      cwd: project,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runtime that finishes opening during dispose is disposed instead of re-registered", async () => {
  const session = new FakeSession();
  const runtime = new FakeRuntime(session);
  let release: ((runtime: PiRuntimeFacade) => void) | undefined;
  const backend = new PiAgentBackend({
    resolveSession: () => ({
      sessionId: "session-1",
      projectPath: "/tmp/project",
      transcriptPath: "/tmp/session-1.jsonl",
      title: "One",
      lastEventAt: 1,
    }),
    onSessionCreated() {},
    runtimeFactory: () => new Promise((resolve) => { release = resolve; }),
    idleRuntimeMs: 1000,
  });

  const opening = backend.page("session-1", 0, 10, "nice");
  await Promise.resolve();
  const disposing = backend.dispose();
  release?.(runtime);

  await expect(opening).rejects.toThrow("disposed");
  await disposing;
  expect(runtime.disposed).toBe(1);
  expect(backend.describeSession("session-1")).toBeUndefined();
});
