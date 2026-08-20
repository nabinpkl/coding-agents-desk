import { afterEach, expect, test } from "bun:test";
import type { SummaryResult } from "@agentdesk/agent-feed-wire";
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
    filesTouched: [],
    risks: [],
    steps: [{ kind: "tool", name: "read", target: "src/a.ts", failed: false }],
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

function post(path = "/api/sessions/pi/s1/summary"): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url.toString(), { method: "POST" }), url];
}

test("a GET is not this route's business", async () => {
  const route = routes(countingRunner());
  const url = new URL("http://127.0.0.1/api/sessions/pi/s1/summary");
  expect(route(new Request(url.toString()), url, server)).toBeUndefined();
});

test("the happy path returns the runner's result", async () => {
  const route = routes(countingRunner());
  const response = await route(...post(), server)!;
  expect(response.status).toBe(200);
  expect(((await response.json()) as SummaryResult).headline).toBe("run 1");
});

test("no credential answers 503 with a code the panel can branch on", async () => {
  mutable.summaryEnabled = false;
  const runner = countingRunner();
  const response = await routes(runner)(...post(), server)!;
  expect(response.status).toBe(503);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("summary-unconfigured");
  expect(runner.runs()).toBe(0);
});

test("a session no source claims is 404", async () => {
  const route = routes(countingRunner());
  const response = await route(...post("/api/sessions/pi/unknown/summary"), server)!;
  expect(response.status).toBe(404);
});

test("a starting catalog answers 503 rather than summarizing a partial inventory", async () => {
  const route = routes(countingRunner());
  state.watcherState = "idle";
  const response = await route(...post(), server)!;
  expect(response.status).toBe(503);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("inventory-not-ready");
});

test("a second press while the first is thinking joins it instead of paying twice", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const runner = countingRunner(gate);
  const route = routes(runner);
  const first = route(...post(), server)!;
  const second = route(...post(), server)!;
  open();
  const [a, b] = await Promise.all([first, second]);
  expect(runner.runs()).toBe(1);
  expect(((await a.json()) as SummaryResult).headline).toBe("run 1");
  expect(((await b.json()) as SummaryResult).headline).toBe("run 1");
});

test("pressing again with no new events is served from cache", async () => {
  const runner = countingRunner();
  const route = routes(runner);
  await route(...post(), server)!;
  const again = await route(...post(), server)!;
  expect(runner.runs()).toBe(1);
  expect(((await again.json()) as SummaryResult).headline).toBe("run 1");
});

test("a failing run answers 502 and is retryable", async () => {
  const route = routes({ async run() { throw new Error("model refused"); } });
  const response = await route(...post(), server)!;
  expect(response.status).toBe(502);
  const body = await response.json() as { error: { code: string; message: string; retryable: boolean } };
  expect(body.error).toMatchObject({ code: "summary-failed", retryable: true });
  expect(body.error.message).toContain("model refused");
});

test("a failed run is not cached, so the next press retries", async () => {
  let calls = 0;
  const route = routes({
    async run() {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return result("second time lucky");
    },
  });
  expect((await route(...post(), server)!).status).toBe(502);
  const retry = await route(...post(), server)!;
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as SummaryResult).headline).toBe("second time lucky");
});
