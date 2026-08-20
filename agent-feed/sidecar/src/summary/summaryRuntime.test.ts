import { afterEach, expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { config } from "../config.ts";
import {
  createSummaryRunner,
  SUMMARY_TOOLS,
  SummaryUnconfiguredError,
  type SummarySession,
  type SummarySessionEvent,
} from "./summaryRuntime.ts";
import type { TurnWindow } from "./turnWindow.ts";

/** `config` is `as const` for readers, not frozen. Tests drive the two flags it gates on. */
const mutable = config as unknown as {
  summaryEnabled: boolean;
  summaryToolCallBudget: number;
  summaryTimeoutMs: number;
};
const original = {
  summaryEnabled: mutable.summaryEnabled,
  summaryToolCallBudget: mutable.summaryToolCallBudget,
  summaryTimeoutMs: mutable.summaryTimeoutMs,
};
mutable.summaryEnabled = true;

afterEach(() => {
  Object.assign(mutable, original, { summaryEnabled: true });
});

const window: TurnWindow = {
  events: [],
  coverage: { fromEventIndex: 4, toEventIndex: 9, mode: "nice", truncated: false },
  gitBlock: "M\t+1\t-0\tsrc/a.ts",
  filesTouched: [{ path: "src/a.ts", status: "M", added: 1, removed: 0 }],
};

const goodReply = '{"headline":"h","narrative":"n","risks":["r"]}';

/** A session that answers with a fixed reply and records what it was asked. */
function fakeSession(overrides: Partial<SummarySession> & { reply?: string | null } = {}) {
  const listeners: Array<(event: SummarySessionEvent) => void> = [];
  const prompts: string[] = [];
  let aborted = 0;
  const session: SummarySession = {
    activeToolNames: () => [...SUMMARY_TOOLS],
    async prompt(text) {
      prompts.push(text);
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    async abort() {
      aborted += 1;
    },
    lastAssistantText: () => (overrides.reply === undefined ? goodReply : overrides.reply),
    ...(({ reply, ...rest }) => rest)(overrides),
  };
  return {
    session,
    prompts,
    emit: (event: SummarySessionEvent | string) =>
      listeners.forEach((listener) =>
        listener(typeof event === "string" ? { type: event } : event)),
    abortCount: () => aborted,
  };
}

test("a finished turn is final, a running one is running", async () => {
  const runner = createSummaryRunner(async () => fakeSession().session, () => 1_750_000_000_000);
  expect((await runner.run({ project: "/p", window, runState: "idle" })).phase).toBe("final");
  expect((await runner.run({ project: "/p", window, runState: "running" })).phase).toBe("running");
});

test("filesTouched and coverage come from the window, never from the model", async () => {
  const runner = createSummaryRunner(
    async () => fakeSession({ reply: '{"headline":"h","narrative":"n","risks":[],"filesTouched":[{"path":"invented.ts"}]}' }).session,
    () => 1_750_000_000_000,
  );
  const result = await runner.run({ project: "/p", window, runState: "idle" });
  expect(result.filesTouched).toEqual(window.filesTouched);
  expect(result.coverage).toEqual(window.coverage);
  expect(result.generatedAt).toBe(1_750_000_000_000);
});

test("no credential raises before any session is created", async () => {
  mutable.summaryEnabled = false;
  let created = false;
  const runner = createSummaryRunner(async () => {
    created = true;
    return fakeSession().session;
  });
  await expect(runner.run({ project: "/p", window, runState: "idle" }))
    .rejects.toThrow(SummaryUnconfiguredError);
  expect(created).toBe(false);
});

test("an unparseable reply raises rather than degrading to a partial digest", async () => {
  const runner = createSummaryRunner(async () => fakeSession({ reply: "I cannot." }).session);
  await expect(runner.run({ project: "/p", window, runState: "idle" })).rejects.toThrow(/no JSON object/);
});

test("a silent run raises rather than returning an empty summary", async () => {
  const runner = createSummaryRunner(async () => fakeSession({ reply: null }).session);
  await expect(runner.run({ project: "/p", window, runState: "idle" })).rejects.toThrow(/no reply/);
});

test("exceeding the tool-call budget aborts the session and fails the run", async () => {
  mutable.summaryToolCallBudget = 2;
  const fake = fakeSession();
  fake.session.prompt = async () => {
    for (let i = 0; i < 5; i += 1) fake.emit("tool_execution_start");
  };
  const runner = createSummaryRunner(async () => fake.session);
  await expect(runner.run({ project: "/p", window, runState: "idle" }))
    .rejects.toThrow(/tool-call budget/);
  // Aborted once, not once per call over the line.
  expect(fake.abortCount()).toBe(1);
});

test("a run inside the budget does not abort", async () => {
  mutable.summaryToolCallBudget = 5;
  const fake = fakeSession();
  fake.session.prompt = async () => {
    for (let i = 0; i < 5; i += 1) fake.emit("tool_execution_start");
  };
  const runner = createSummaryRunner(async () => fake.session);
  await runner.run({ project: "/p", window, runState: "idle" });
  expect(fake.abortCount()).toBe(0);
});

test("a session that never answers times out and aborts", async () => {
  mutable.summaryTimeoutMs = 5_000;
  const fake = fakeSession();
  fake.session.prompt = () => new Promise<void>(() => {});
  const runner = createSummaryRunner(async () => fake.session);
  await expect(runner.run({ project: "/p", window, runState: "idle" }))
    .rejects.toThrow(/did not answer within/);
  expect(fake.abortCount()).toBe(1);
}, 20_000);

test("the digest carries what the run thought and looked at, in order", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "  Read the runtime first.  " },
    });
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "src/a.ts", offset: 1, limit: 200 },
    });
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "c2",
      toolName: "grep",
      args: { pattern: "getAllTools", glob: "*.ts", path: "src" },
    });
  };
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({ project: "/p", window, runState: "idle" });

  expect(result.steps).toEqual([
    { kind: "thinking", text: "Read the runtime first." },
    // The offset and limit are dropped: a viewer wants the file, not how much of it was read.
    { kind: "tool", name: "read", target: "src/a.ts", failed: false },
    { kind: "tool", name: "grep", target: "getAllTools *.ts in src", failed: false },
  ]);
});

test("a path inside the project is shown relative to it, one outside is not", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    // What the model actually sends: Pi's read tool takes absolute paths, so left alone the
    // trace reads as a column of /Users/... noise beside a file list that is repo-relative.
    fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "/p/src/a.ts" } });
    fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "/etc/hosts" } });
    fake.emit({ type: "tool_execution_start", toolName: "ls", args: { path: "/p" } });
  };
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({ project: "/p", window, runState: "idle" });

  expect(result.steps.map((step) => (step as { target: string }).target))
    .toEqual(["src/a.ts", "/etc/hosts", "."]);
});

test("a lookup that failed says so, and the ones around it do not", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    fake.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "gone.ts" } });
    fake.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "ls", args: { path: "src" } });
    fake.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: true });
    fake.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "ls", isError: false });
  };
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({ project: "/p", window, runState: "idle" });

  expect(result.steps).toEqual([
    { kind: "tool", name: "read", target: "gone.ts", failed: true },
    { kind: "tool", name: "ls", target: "src", failed: false },
  ]);
});

test("a long reasoning block is cut with a mark, not silently", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "x".repeat(5_000) },
    });
    // Deltas are noise: only the assembled block is recorded, or every reasoning token would
    // arrive as its own step.
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", content: "ignored" },
    });
  };
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({ project: "/p", window, runState: "idle" });

  expect(result.steps).toHaveLength(1);
  const [thought] = result.steps;
  expect(thought).toMatchObject({ kind: "thinking" });
  expect((thought as { text: string }).text).toBe(`${"x".repeat(2_000)}…`);
});

test("a run that used no tools and showed no reasoning reports no steps", async () => {
  const runner = createSummaryRunner(async () => fakeSession().session);
  expect((await runner.run({ project: "/p", window, runState: "idle" })).steps).toEqual([]);
});

/**
 * The security claim, checked against Pi rather than against our own constant.
 *
 * Offline: building a session resolves a model definition and a tool registry, and calls no
 * model. Without the allowlist Pi reports read/bash/edit/write, so this fails loudly if the
 * `tools` option ever stops being honoured -- which is the failure that would silently hand a
 * bash tool to a model reading attacker-influenced transcript text.
 */
test("Pi honours the read-only allowlist", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(config.summaryProvider, async () => ({ type: "api_key", key: "not-used-offline" }));
  const modelRuntime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
  const model = modelRuntime.getModel(config.summaryProvider, config.summaryModel);
  expect(model, `${config.summaryProvider}/${config.summaryModel} is not in Pi's catalog`).toBeTruthy();

  const services = await createAgentSessionServices({ cwd: process.cwd(), modelRuntime });
  const restricted = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(process.cwd()),
    model: model!,
    tools: [...SUMMARY_TOOLS],
  });
  const names = restricted.session.getAllTools().map((tool) => tool.name).sort();
  expect(names).toEqual([...SUMMARY_TOOLS].sort());
  expect(names).not.toContain("bash");
  expect(names).not.toContain("write");
  expect(names).not.toContain("edit");
}, 60_000);
