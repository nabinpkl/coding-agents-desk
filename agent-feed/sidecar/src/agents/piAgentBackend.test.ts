import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentCommandConflictError, PiAgentBackend, type PiRuntimeFacade, type PiSessionFacade } from "./piAgentBackend.ts";

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
