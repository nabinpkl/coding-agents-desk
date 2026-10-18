import { afterEach, expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SummaryStreamMessage } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import {
  createSummaryRunner,
  SUMMARY_TOOLS,
  SummaryUnconfiguredError,
  type SummarySession,
  type SummarySessionEvent,
} from "@/summary/summaryRuntime";
import type { TurnWindow } from "@/summary/turnWindow";

/** `config` is `as const` for readers, not frozen. Tests drive the two flags it gates on. */
const mutable = config as unknown as {
  summaryEnabled: boolean;
  summaryTimeoutMs: number;
};
const original = {
  summaryEnabled: mutable.summaryEnabled,
  summaryTimeoutMs: mutable.summaryTimeoutMs,
};
mutable.summaryEnabled = true;

afterEach(() => {
  Object.assign(mutable, original, { summaryEnabled: true });
});

const window: TurnWindow = {
  events: [],
  coverage: { fromEventIndex: 4, toEventIndex: 9, mode: "nice", truncated: false },
  filesTouched: [{ path: "src/a.ts", action: "edited", edits: 1, added: 1, removed: 0 }],
};

const goodReply = '{"headline":"h","narrative":"n","risks":["r"]}';

/**
 * The two field names Pi uses for reasoning, taken from Pi's own event union rather than
 * retyped here.
 *
 * They are NOT the same name -- a delta carries `delta` and the assembled block carries
 * `content` -- and reading the wrong one produces no error and no reasoning, just a stream that
 * is quietly missing half of what it was built to show. That is what happened, and it took a
 * live run against the real model to notice. `satisfies` makes a rename in Pi fail here instead.
 */
const DELTA_FIELD = "delta" satisfies keyof Extract<AssistantMessageEvent, { type: "thinking_delta" }>;
const BLOCK_FIELD = "content" satisfies keyof Extract<AssistantMessageEvent, { type: "thinking_end" }>;

/** A session that answers with a fixed reply and records what it was asked. */
function fakeSession(overrides: Partial<SummarySession> & { reply?: string | null } = {}) {
  const listeners: Array<(event: SummarySessionEvent) => void> = [];
  const prompts: string[] = [];
  let aborted = 0;
  const session: SummarySession = {
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
    ...(({ reply: _reply, ...rest }) => rest)(overrides),
  };
  return {
    session,
    prompts,
    emit: (event: SummarySessionEvent | string) =>
      listeners.forEach((listener) => listener(typeof event === "string" ? { type: event } : event)),
    abortCount: () => aborted,
  };
}

test("a finished turn is final, a running one is running", async () => {
  const runner = createSummaryRunner(
    async () => fakeSession().session,
    () => 1_750_000_000_000,
  );
  expect((await runner.run({ project: "/p", window, runState: "idle" })).phase).toBe("final");
  expect((await runner.run({ project: "/p", window, runState: "running" })).phase).toBe("running");
});

test("filesTouched and coverage come from the window, never from the model", async () => {
  const runner = createSummaryRunner(
    async () =>
      fakeSession({ reply: '{"headline":"h","narrative":"n","risks":[],"filesTouched":[{"path":"invented.ts"}]}' })
        .session,
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
  await expect(runner.run({ project: "/p", window, runState: "idle" })).rejects.toThrow(SummaryUnconfiguredError);
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

test("a session that never answers times out and aborts", async () => {
  mutable.summaryTimeoutMs = 5_000;
  const fake = fakeSession();
  fake.session.prompt = () => new Promise<void>(() => {});
  const runner = createSummaryRunner(async () => fake.session);
  await expect(runner.run({ project: "/p", window, runState: "idle" })).rejects.toThrow(/did not answer within/);
  expect(fake.abortCount()).toBe(1);
}, 20_000);

test("a long reasoning block is cut with a mark, not silently", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", [BLOCK_FIELD]: "x".repeat(5_000) },
    });
    // Deltas are noise: only the assembled block is recorded, or every reasoning token would
    // arrive as its own step.
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", [DELTA_FIELD]: "ignored" },
    });
  };
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({ project: "/p", window, runState: "idle" });

  expect(result.reasoning).toEqual([`${"x".repeat(2_000)}…`]);
});

test("the run is reported as it happens, not only when it finishes", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", [DELTA_FIELD]: "Read " },
    });
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", [DELTA_FIELD]: "the runtime." },
    });
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", [BLOCK_FIELD]: "Read the runtime." },
    });
  };
  const messages: SummaryStreamMessage[] = [];
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({
    project: "/p",
    window,
    runState: "idle",
    onMessage: (message) => messages.push(message),
  });

  expect(messages).toEqual([
    // The two token-sized deltas coalesce, and the tail is superseded by the block that
    // completes it rather than sent twice.
    { type: "reasoning", text: "Read the runtime." },
  ]);
  // Whoever watched the run and whoever only reads the artifact see the same thing.
  expect(result.reasoning).toEqual(
    messages.filter((message) => message.type === "reasoning").map((message) => message.text),
  );
});

test("reasoning is sent by the sentence, not by the token", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    // Pi's real shape: one event per token.
    for (let i = 0; i < 600; i += 1) {
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", [DELTA_FIELD]: "word " },
      });
    }
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", [BLOCK_FIELD]: "word ".repeat(400).trim() },
    });
  };
  const messages: SummaryStreamMessage[] = [];
  const runner = createSummaryRunner(async () => fake.session);

  await runner.run({
    project: "/p",
    window,
    runState: "idle",
    onMessage: (message) => messages.push(message),
  });

  const deltas = messages.filter((message) => message.type === "thinking-delta");
  expect(deltas.length).toBeLessThan(20);
  // Nothing is lost by coalescing: 600 tokens, capped at 2,000 characters, all present.
  expect(deltas.map((message) => message.text).join("")).toBe("word ".repeat(400));
  // And the assembled block still lands last, superseding what the deltas built.
  expect(messages.at(-1)).toEqual({ type: "reasoning", text: "word ".repeat(400).trim() });
});

test("the deltas stop where the recorded block is cut, so live and final agree", async () => {
  const fake = fakeSession();
  fake.session.prompt = async () => {
    for (let i = 0; i < 3; i += 1) {
      fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", [DELTA_FIELD]: "x".repeat(900) },
      });
    }
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", [BLOCK_FIELD]: "x".repeat(2_700) },
    });
  };
  const messages: SummaryStreamMessage[] = [];
  const runner = createSummaryRunner(async () => fake.session);

  const result = await runner.run({
    project: "/p",
    window,
    runState: "idle",
    onMessage: (message) => messages.push(message),
  });

  const deltas = messages.filter((message) => message.type === "thinking-delta");
  const streamed = deltas.map((message) => message.text).join("");
  // 2,700 characters of reasoning, cut at the same 2,000 on both paths. Without this the viewer
  // would watch the text run past the cap and then visibly shrink when the block settled.
  expect(streamed).toBe("x".repeat(2_000));
  // And sent as a handful of messages, not one per token. Pi emits a token at a time; a real
  // run turned 4,450 characters into 918 messages and 918 React updates, and the panel stopped
  // repainting part-way through.
  expect(deltas.length).toBeLessThanOrEqual(2_000 / 200);
  expect(result.reasoning[0]).toBe(`${"x".repeat(2_000)}…`);
});

test("a run whose reasoning was not visible reports none, rather than inventing it", async () => {
  const runner = createSummaryRunner(async () => fakeSession().session);
  expect((await runner.run({ project: "/p", window, runState: "idle" })).reasoning).toEqual([]);
});

/**
 * The security claim, checked against Pi rather than against our own constant.
 *
 * Offline: building a session resolves a model definition and a tool registry, and calls no
 * model. Pi's default for a session is read/bash/edit/write, so this fails loudly if the `tools`
 * option ever stops being honoured -- which is the failure that would hand a bash tool to a
 * model whose entire input is transcript text an attacker can shape.
 */
test("Pi honours an empty tool set", async () => {
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
  expect(restricted.session.getAllTools().map((tool) => tool.name)).toEqual([]);
}, 60_000);
