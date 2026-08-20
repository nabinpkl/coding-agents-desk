import { afterEach, expect, test } from "bun:test";
import type { SummaryResult, SummaryStreamMessage } from "@agentdesk/agent-feed-wire";
import type { AgentBackend, AgentSessionDescriptor } from "../agents/agentBackend.ts";
import { config } from "../config.ts";
import type { SummaryRunInput, SummaryRunner } from "../summary/summaryRuntime.ts";
import { state } from "../transcripts/transcriptState.ts";
import { createSummaryRoutes } from "./summaryRoutes.ts";

const server = { timeout() {} } as never;

const mutable = config as unknown as { summaryEnabled: boolean };
const wasEnabled = mutable.summaryEnabled;
mutable.summaryEnabled = true;

afterEach(() => {
  mutable.summaryEnabled = true;
  state.watcherState = "idle";
});
process.on("exit", () => {
  mutable.summaryEnabled = wasEnabled;
});

const descriptor: AgentSessionDescriptor = {
  sessionId: "s1",
  source: "pi",
  projectPath: "/tmp/project",
  title: "a session",
  lastEventAt: 1_750_000_000_000,
  activity: "ready",
  capabilities: {
    modes: ["nice"], canSend: true, canSteer: true, canAbort: true, canFetchRaw: false,
    canOpenTerminal: false, supportsExtensionUi: false, canStreamLive: false,
  },
};

/** A backend holding two events, so the turn window has something to find. */
function backend(): AgentBackend {
  return {
    id: "pi",
    capabilities: descriptor.capabilities,
    describeSession: () => descriptor,
    createSession: async () => descriptor,
    async page() {
      return {
        events: [
          { id: "e0", index: 0, revision: 0, phase: "complete", ts: 1, type: "user", blocks: [{ kind: "text", text: "go" }] },
          { id: "e1", index: 1, revision: 0, phase: "complete", ts: 2, type: "assistant", blocks: [{ kind: "text", text: "done" }] },
        ],
        total: 2,
        mode: "nice",
        sequence: 2,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      };
    },
    subscribe: async () => () => {},
    send: async () => ({ requestId: "r", delivery: "immediate" }),
    abort: async () => ({ requestId: "r", delivery: "abort" }),
    subscribeUi: async () => () => {},
    respondToUi: async () => "accepted",
    dispose: async () => {},
  };
}

function result(headline: string): SummaryResult {
  return {
    phase: "final",
    generatedAt: 1,
    model: "m",
    headline,
    narrative: "n",
    filesTouched: [{ path: "src/a.ts", action: "edited", edits: 1, added: 2, removed: 1 }],
    risks: [],
    reasoning: ["The turn names src/a.ts and the file list confirms it."],
    coverage: { fromEventIndex: 0, toEventIndex: 1, mode: "nice", truncated: false },
    runState: "idle",
  };
}

/** Counts runs and can be held open, so dedupe is observable. */
function countingRunner(gate?: Promise<void>): SummaryRunner & { runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    async run(_input: SummaryRunInput) {
      runs += 1;
      if (gate) await gate;
      return result(`run ${runs}`);
    },
  };
}

function routes(runner: SummaryRunner) {
  state.watcherState = "live";
  return createSummaryRoutes(
    (id) => (id === "pi" ? backend() : undefined),
    (source, sessionId) => (source === "pi" && sessionId === "s1" ? descriptor : undefined),
    runner,
  );
}

function get(path = "/api/sessions/pi/s1/summary"): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url.toString()), url];
}

/**
 * Everything one stream said, in order.
 *
 * `response.text()` returns only because the route closes its own stream after the terminal
 * message. A stream left open would hang this helper, which is the same thing it would do to an
 * `EventSource` waiting for more.
 */
async function collect(response: Response): Promise<SummaryStreamMessage[]> {
  return (await response.text())
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as SummaryStreamMessage);
}

function terminal(messages: SummaryStreamMessage[]): SummaryStreamMessage | undefined {
  return messages.at(-1);
}

test("a POST is not this route's business", async () => {
  const route = routes(countingRunner());
  const url = new URL("http://127.0.0.1/api/sessions/pi/s1/summary");
  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
});

test("the happy path streams the run and ends with the digest", async () => {
  const route = routes(countingRunner());
  const response = await route(...get(), server)!;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const messages = await collect(response);
  expect(terminal(messages)).toEqual({ type: "result", result: result("run 1") });
});

test("what the run does reaches the stream while it is still running", async () => {
  const route = routes({
    async run(input: SummaryRunInput) {
      input.onMessage?.({ type: "thinking-delta", text: "Read " });
      input.onMessage?.({ type: "thinking-delta", text: "the runtime." });
      input.onMessage?.({ type: "reasoning", text: "Read the runtime." });
      return result("done");
    },
  });

  const messages = await collect(await route(...get(), server)!);

  expect(messages.map((message) => message.type))
    .toEqual(["thinking-delta", "thinking-delta", "reasoning", "result"]);
});

test("no credential answers 503 with a code the panel can branch on", async () => {
  mutable.summaryEnabled = false;
  const runner = countingRunner();
  const response = await routes(runner)(...get(), server)!;
  expect(response.status).toBe(503);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("summary-unconfigured");
  expect(runner.runs()).toBe(0);
});

test("a session no source claims is 404", async () => {
  const route = routes(countingRunner());
  const response = await route(...get("/api/sessions/pi/unknown/summary"), server)!;
  expect(response.status).toBe(404);
});

test("a starting catalog answers 503 rather than summarizing a partial inventory", async () => {
  const route = routes(countingRunner());
  state.watcherState = "idle";
  const response = await route(...get(), server)!;
  expect(response.status).toBe(503);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("inventory-not-ready");
});

test("a second viewer joins the run instead of paying for a second one", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const runner = countingRunner(gate);
  const route = routes(runner);
  const first = (await route(...get(), server)!) as Response;
  const second = (await route(...get(), server)!) as Response;
  open();

  const [a, b] = await Promise.all([collect(first), collect(second)]);

  expect(runner.runs()).toBe(1);
  expect(terminal(a)).toEqual({ type: "result", result: result("run 1") });
  expect(terminal(b)).toEqual({ type: "result", result: result("run 1") });
});

test("a viewer who opens mid-run is replayed what it has already said", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let emit!: (message: SummaryStreamMessage) => void;
  let running!: () => void;
  // The run does not begin the instant the stream opens -- the turn window is resolved first --
  // so the test waits for it rather than racing it.
  const started = new Promise<void>((resolve) => { running = resolve; });
  const route = routes({
    async run(input: SummaryRunInput) {
      emit = (message) => input.onMessage?.(message);
      emit({ type: "reasoning", text: "early" });
      running();
      await gate;
      return result("done");
    },
  });

  const first = (await route(...get(), server)!) as Response;
  await started;
  // The phone opening the same thread the Mac is already watching: it should not see a blank
  // panel just because it arrived second.
  const late = (await route(...get(), server)!) as Response;
  emit({ type: "reasoning", text: "late" });
  open();

  const [a, b] = await Promise.all([collect(first), collect(late)]);
  expect(a.map((message) => message.type)).toEqual(["reasoning", "reasoning", "result"]);
  expect(b).toEqual(a);
});

test("asking again with no new events is served from cache", async () => {
  const runner = countingRunner();
  const route = routes(runner);
  await collect(await route(...get(), server)!);
  const again = await collect(await route(...get(), server)!);
  expect(runner.runs()).toBe(1);
  expect(terminal(again)).toEqual({ type: "result", result: result("run 1") });
});

test("a failing run reports the code in the stream, which itself opened fine", async () => {
  const route = routes({ async run() { throw new Error("model refused"); } });
  const response = await route(...get(), server)!;
  // 200: by the time a run can fail, the response has been committed as an event stream. The
  // code the panel branches on is the same either way.
  expect(response.status).toBe(200);

  const last = terminal(await collect(response));
  expect(last).toMatchObject({
    type: "error",
    error: { code: "summary-failed", retryable: true },
  });
  expect((last as { error: { message: string } }).error.message).toContain("model refused");
});

test("a failed run is not cached, so the next viewer retries", async () => {
  let calls = 0;
  const route = routes({
    async run() {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return result("second time lucky");
    },
  });
  expect(terminal(await collect(await route(...get(), server)!))).toMatchObject({ type: "error" });
  const retry = terminal(await collect(await route(...get(), server)!));
  expect(retry).toEqual({ type: "result", result: result("second time lucky") });
});
