// A fake backend rather than a real serve: what is pinned here is the driving contract --
// subscribe before send, close only after running, one event per id -- not the serve's behavior,
// which the pool's own tests pin.

import { describe, expect, test } from "bun:test";
import {
  OpencodeContestantError,
  runOpencodeContestant,
  type OpencodeContestantBackend,
} from "@/arena/opencodeContestant";
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
  const subscriptions: ((envelope: TimelineEnvelope) => void)[] = [];
  const backend: OpencodeContestantBackend = {
    async createSession() {
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
  return { backend, sent, deliver };
}

const plan = { prompt: "say one word", worktreePath: "/nowhere/c1", requestId: "run-1:c1", turnTimeoutMs: 1000 };

describe("runOpencodeContestant", () => {
  test("sends the prompt as one next delivery, in the session it created", async () => {
    const { backend, sent } = fakeBackend({
      envelopes: [envelope({ runState: "running" }), envelope({ runState: "idle" })],
    });
    const result = await runOpencodeContestant(backend, plan);
    expect(sent).toEqual([{ sessionId: result.sessionId, text: "say one word", delivery: "next" }]);
  });

  test("collects the turn's events once each, snapshots merged with upserts", async () => {
    const { backend } = fakeBackend({
      envelopes: [
        // A snapshot re-states rows, then a later upsert repeats one and adds another: the
        // collected turn is one event per id in projection order.
        envelope({ kind: "snapshot", events: [event("a"), event("b", "read")] }),
        envelope({ kind: "upsert", events: [event("b", "read"), event("c")] }),
        envelope({ runState: "running" }),
        envelope({ runState: "idle" }),
      ],
    });
    const result = await runOpencodeContestant(backend, plan);
    expect(result.events.map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(result.events[1]?.blocks[0]).toMatchObject({ tool: "read", files: ["/repo/README"] });
  });

  test("closes only after the turn was seen running, so an idle projection is not a finished one", async () => {
    const { backend, deliver } = fakeBackend({});
    const finished = runOpencodeContestant(backend, plan);
    // The driver subscribes before it sends, so the turn's envelopes can only arrive after the
    // subscription exists: one tick past the send is where a slow serve's first envelope lands.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The turn opens after the send returns -- driven from the test, in the order a slow serve
    // actually delivers: running, events, idle.
    deliver(envelope({ runState: "running" }));
    deliver(envelope({ kind: "upsert", events: [event("a")] }));
    deliver(envelope({ runState: "idle" }));

    expect((await finished).events.map((one) => one.id)).toEqual(["a"]);
  });

  test("fails a turn that never closes, rather than waiting forever", async () => {
    const { backend } = fakeBackend({ envelopes: [envelope({ runState: "running" })] });
    await expect(runOpencodeContestant(backend, plan)).rejects.toThrow(OpencodeContestantError);
  });

  test("a queued follow-up holds the turn open until the queue drains", async () => {
    const { backend, deliver } = fakeBackend({});
    const finished = runOpencodeContestant(backend, plan);
    await new Promise((resolve) => setTimeout(resolve, 5));
    deliver(envelope({ runState: "running" }));
    deliver(envelope({ runState: "idle", queue: { steer: 0, followUp: 1 } }));
    deliver(envelope({ runState: "idle", queue: { steer: 0, followUp: 0 } }));
    await finished;
  });

  test("carries the usage the backend named at close", async () => {
    const { backend } = fakeBackend({
      envelopes: [envelope({ runState: "running" }), envelope({ runState: "idle" })],
      usage: { current: 1234, limit: 200_000, updatedAt: 1, cost: 0.02 },
    });
    const result = await runOpencodeContestant(backend, plan);
    expect(result.usage).toEqual({ current: 1234, limit: 200_000, updatedAt: 1, cost: 0.02 });
  });

  test("reports the session the moment it exists, before the turn has run", async () => {
    const { backend, deliver } = fakeBackend({});
    const seen: string[] = [];
    // The drive is still open when this must have fired: the promise below has not resolved.
    const finished = runOpencodeContestant(backend, {
      ...plan,
      onSessionId: (sessionId) => seen.push(sessionId),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["ses-arena"]);
    // Close the turn so the drive does not end this test on its own timeout.
    deliver(envelope({ runState: "running" }));
    deliver(envelope({ runState: "idle" }));
    await finished;
  });

  test("a send that fails surfaces as itself, with the subscription released", async () => {
    const { backend, deliver } = fakeBackend({ sendError: new Error("serve refused") });
    await expect(runOpencodeContestant(backend, plan)).rejects.toThrow("serve refused");
    // A late envelope from a released subscription cannot close anything that already failed.
    deliver(envelope({ runState: "running" }));
    deliver(envelope({ runState: "idle" }));
  });
});
