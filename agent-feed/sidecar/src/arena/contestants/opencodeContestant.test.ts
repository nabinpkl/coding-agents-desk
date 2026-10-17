// A fake backend and a fake outcome reader rather than a real serve: what is pinned here is the
// driving contract -- subscribe before send, close on the serve's own end-of-turn marker and
// nothing else, fail with the serve's reason, one event per id -- not the serve's behavior,
// which the pool's own tests pin. The marker's shape is pinned by `turnOutcomeOf` below,
// against messages copied from this machine's serve.

import { describe, expect, test } from "bun:test";
import {
  OpencodeContestantError,
  runOpencodeContestant,
  turnOutcomeOf,
  type OpencodeContestantBackend,
  type OpencodeTurnOutcome,
} from "@/arena/contestants/opencodeContestant";
import type { TimelineEnvelope } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

const event = (id: string, tool?: string): ActivityEvent => ({
  id,
  index: 0,
  revision: 1,
  phase: "complete",
  ts: 1,
  type: "assistant",
  blocks: tool
    ? [{ kind: "tool_use", tool, files: ["/repo/README"] }]
    : [{ kind: "text", text: `event ${id}` }],
});

const envelope = (over: Partial<TimelineEnvelope> = {}): TimelineEnvelope => ({
  kind: "state",
  sequence: 1,
  mode: "nice",
  events: [],
  windowStart: 0,
  runState: "idle",
  queue: { steer: 0, followUp: 0 },
  ...over,
});

/** A backend that answers from a script of envelopes, in the order the driver needs them. */
function fakeBackend(options: {
  sessionId?: string;
  envelopes?: TimelineEnvelope[];
  sendError?: Error;
  usage?: { current: number; limit: number | null; updatedAt: number; cost?: number } | null;
}) {
  const sent: { sessionId: string; text: string; delivery: string }[] = [];
  const created: { projectPath: string }[] = [];
  const subscriptions: ((envelope: TimelineEnvelope) => void)[] = [];
  const backend: OpencodeContestantBackend = {
    async createSession(_requestId, projectPath) {
      created.push({ projectPath });
      return {
        sessionId: options.sessionId ?? "ses-arena",
        source: "opencode",
        projectPath: "/nowhere/c1",
        title: "contestant",
        lastEventAt: 1,
        activity: "ready",
        capabilities: {
          modes: ["nice"],
          canSend: true,
          canSteer: true,
          canAbort: true,
          canFetchRaw: false,
          canOpenTerminal: true,
          supportsExtensionUi: true,
          canStreamLive: false,
        },
      };
    },
    async subscribe(_sessionId, _after, listener) {
      subscriptions.push(listener);
      return () => subscriptions.splice(subscriptions.indexOf(listener), 1);
    },
    async send(sessionId, _requestId, text, delivery) {
      sent.push({ sessionId, text, delivery });
      if (options.sendError) throw options.sendError;
      // The turn, played back the way the serve plays it: running while it works, idle when done.
      for (const one of options.envelopes ?? []) {
        for (const listener of subscriptions) listener(one);
      }
      return { requestId: "r", delivery: "immediate" };
    },
    sessionUsage: () => (options.usage === undefined ? null : options.usage),
  };
  const deliver = (one: TimelineEnvelope): void => {
    for (const listener of subscriptions) listener(one);
  };
  return { backend, sent, created, deliver };
}

const plan = {
  prompt: "say one word",
  worktreePath: "/nowhere/c1",
  requestId: "run-1:c1",
  turnTimeoutMs: 1000,
  onSessionId: () => {},
};

/** The serve's answer about the turn, as each test sets it; `reads` counts the asks. */
function fakeServe(initial: OpencodeTurnOutcome = { closed: false }) {
  const serve = { outcome: initial, reads: 0 };
  const options = {
    turnOutcome: async () => {
      serve.reads += 1;
      return serve.outcome;
    },
    recheckMs: 10,
  };
  return { serve, options };
}

const SUCCEEDED: OpencodeTurnOutcome = { closed: true, failure: null };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runOpencodeContestant", () => {
  test("sends the prompt as one next delivery, in the session it created", async () => {
    const { backend, sent } = fakeBackend({ envelopes: [envelope({ runState: "idle" })] });
    const { options } = fakeServe(SUCCEEDED);
    const result = await runOpencodeContestant(backend, plan, options);
    expect(sent).toEqual([{ sessionId: result.sessionId, text: "say one word", delivery: "next" }]);
  });

  test("collects the turn's events once each, snapshots merged with upserts", async () => {
    const { backend, deliver } = fakeBackend({});
    const { serve, options } = fakeServe();
    const finished = runOpencodeContestant(backend, plan, options);
    await tick();
    // A snapshot re-states rows, then a later upsert repeats one and adds another: the
    // collected turn is one event per id in projection order.
    deliver(envelope({ kind: "snapshot", runState: "running", events: [event("a"), event("b", "read")] }));
    deliver(envelope({ kind: "upsert", runState: "running", events: [event("b", "read"), event("c")] }));
    serve.outcome = SUCCEEDED;
    deliver(envelope({ runState: "idle" }));
    const result = await finished;
    expect(result.events.map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(result.events[1]?.blocks[0]).toMatchObject({ tool: "read", files: ["/repo/README"] });
  });

  test("an idle projection is not a finished turn: only the serve's marker closes it", async () => {
    // Measured: the mapper counts a user row as closed, so the projection reads idle right
    // after the send, before the model has said a word.
    const { backend, deliver } = fakeBackend({});
    const { serve, options } = fakeServe();
    let done = false;
    const finished = runOpencodeContestant(backend, plan, options).then((result) => {
      done = true;
      return result;
    });
    await tick();
    deliver(envelope({ kind: "upsert", runState: "idle", events: [event("u")] }));
    await tick(30);
    expect(done).toBe(false);
    expect(serve.reads).toBeGreaterThan(0);

    serve.outcome = SUCCEEDED;
    deliver(envelope({ kind: "upsert", runState: "idle", events: [event("a")] }));
    expect((await finished).events.map((one) => one.id)).toEqual(["u", "a"]);
  });

  test("a turn the serve failed fails the contestant at once, with the serve's reason", async () => {
    // Measured on a spent quota: no `running` ever published, just idle rows and the marker.
    const { backend } = fakeBackend({ envelopes: [envelope({ runState: "idle" })] });
    const { options } = fakeServe({ closed: true, failure: "provider.quota: Go usage limit exceeded" });
    await expect(runOpencodeContestant(backend, plan, options)).rejects.toThrow(
      "provider.quota: Go usage limit exceeded",
    );
  });

  test("reads once more when the marker lands after the last envelope", async () => {
    const { backend, deliver } = fakeBackend({});
    const { serve, options } = fakeServe();
    const finished = runOpencodeContestant(backend, plan, options);
    await tick();
    deliver(envelope({ runState: "idle" }));
    await tick();
    // No envelope follows this: the follow-up read is the only thing left to notice it.
    serve.outcome = SUCCEEDED;
    await finished;
    expect(serve.reads).toBeGreaterThan(1);
  });

  test("a running envelope does not ask; the turn is plainly still open", async () => {
    const { backend, deliver } = fakeBackend({});
    const { serve, options } = fakeServe(SUCCEEDED);
    const finished = runOpencodeContestant(backend, { ...plan, turnTimeoutMs: 200 }, options);
    await tick();
    const afterSend = serve.reads;
    deliver(envelope({ runState: "running" }));
    deliver(envelope({ runState: "running" }));
    expect(serve.reads).toBe(afterSend);
    await finished;
  });

  test("fails a turn that never closes, rather than waiting forever", async () => {
    const { backend } = fakeBackend({ envelopes: [envelope({ runState: "running" })] });
    const { options } = fakeServe();
    await expect(
      runOpencodeContestant(backend, { ...plan, turnTimeoutMs: 50 }, options),
    ).rejects.toThrow(OpencodeContestantError);
  });

  test("carries the usage the backend named at close", async () => {
    const { backend } = fakeBackend({
      envelopes: [envelope({ runState: "idle" })],
      usage: { current: 1234, limit: 200_000, updatedAt: 1, cost: 0.02 },
    });
    const result = await runOpencodeContestant(backend, plan, fakeServe(SUCCEEDED).options);
    expect(result.usage).toEqual({ current: 1234, limit: 200_000, updatedAt: 1, cost: 0.02 });
  });

  test("reports the session the moment it exists, before the turn has run", async () => {
    const { backend, deliver } = fakeBackend({});
    const { serve, options } = fakeServe();
    const seen: string[] = [];
    const finished = runOpencodeContestant(
      backend,
      { ...plan, onSessionId: (sessionId) => seen.push(sessionId) },
      options,
    );
    await tick();
    expect(seen).toEqual(["ses-arena"]);
    serve.outcome = SUCCEEDED;
    deliver(envelope({ runState: "idle" }));
    await finished;
  });

  test("creates a plain session in the worktree, with no rules of its own", async () => {
    const { backend, created } = fakeBackend({ envelopes: [envelope({ runState: "idle" })] });
    await runOpencodeContestant(backend, plan, fakeServe(SUCCEEDED).options);
    expect(created).toEqual([{ projectPath: plan.worktreePath }]);
  });

  test("a send that fails surfaces as itself, with the subscription released", async () => {
    const { backend, deliver } = fakeBackend({ sendError: new Error("serve refused") });
    const { serve, options } = fakeServe(SUCCEEDED);
    await expect(runOpencodeContestant(backend, plan, options)).rejects.toThrow("serve refused");
    // A late envelope from a released subscription asks nothing of a drive that already failed.
    deliver(envelope({ runState: "idle" }));
    expect(serve.reads).toBe(0);
  });
});
