// A turn's words reach the projection as the serve publishes them, and the read that ends the
// step settles the same row rather than adding one.
//
// The property under test is the one a reader would describe as "it streams": every delta
// produces its own row, in order, with the text so far -- and none of them costs a fetch of the
// message history. The fake serve counts those fetches, because before this each delta bought
// one (coalesced into a re-read that arrived later than the words it was re-reading for).
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { OpencodeClient } from "@/agents/opencode/serve/opencodeClient";
import type { TimelineEnvelope } from "@/agents/liveAgentProjection";
import { OpencodeSessionPool, REFRESH_COALESCE_MS } from "@/agents/opencode/opencodeSessionPool";
import { drained } from "@/testing/until";
import type { SessionMessageInfo as SessionMessage } from "@opencode/client";

const CAPABILITIES = {
  canSend: true,
  canStreamLive: true,
  canInterrupt: true,
  canOpenTerminal: false,
  supportsExtensionUi: true,
  canFork: true,
  canCompact: true,
  canRename: true,
  supportsImages: true,
  supportsModelSwitch: true,
} as never;

interface Harness {
  pool: OpencodeSessionPool;
  push: (event: unknown) => void;
  /** What the next history read answers with, which is how a turn reaches the serve's file. */
  settle: (messages: SessionMessage[]) => void;
  /** What the serve's next `session.get` names as the session's model. */
  setServeModel: (modelId: string) => void;
  historyReads: () => number;
  dispose: () => Promise<void>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

/**
 * A serve that publishes one turn's words on demand, and counts the history reads the sidecar
 * makes against it. The history it serves is whatever the test puts in `durable`, so the
 * handoff can be watched: a message that is streamed first and only later readable.
 */
function harness(initial: SessionMessage[] = []): Harness {
  let durable: SessionMessage[] = initial;
  let reads = 0;
  // The model the serve names, changed by the test to stage a switch.
  let serveModelId = "m";
  // A real queue rather than a one-shot promise: the sidecar keeps one stream open for every
  // session it owns, and a test that published a single event would prove nothing about the
  // second, third or fourth -- which is exactly the range this is about.
  const waiting: ((event: unknown) => void)[] = [];
  const queued: unknown[] = [];
  const push = (event: unknown): void => {
    const next = waiting.shift();
    if (next) next(event);
    else queued.push(event);
  };

  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/message")) {
      reads += 1;
      return Response.json({ data: [...durable].reverse() });
    }
    if (parsed.pathname === "/api/model") {
      return Response.json({
        data: [{ providerID: "opencode-go", modelID: "m", name: "M", limit: { context: 1000 }, cost: [] }],
      });
    }
    return Response.json({ data: {} });
  }) as typeof globalThis.fetch;

  const client = {
    session: {
      get: async () => ({ id: "s1", model: { id: serveModelId, providerID: "opencode-go" }, tokens: null }),
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) =>
        (async function* () {
          for (;;) {
            const event =
              queued.length > 0
                ? queued.shift()
                : await new Promise<unknown>((resolve, reject) => {
                    options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                    waiting.push(resolve);
                  });
            yield event;
          }
        })(),
    },
  } as unknown as OpencodeClient;

  const pool = new OpencodeSessionPool({
    resolveSession: () => ({ sessionId: "s1", source: "opencode", projectPath: "/repo" }),
    onSessionCreated: () => {},
    onCatalogChanged: () => {},
    capabilities: CAPABILITIES,
    client: () => client,
  });
  return {
    pool,
    push,
    settle: (messages) => {
      durable = messages;
    },
    setServeModel: (modelId) => {
      serveModelId = modelId;
    },
    historyReads: () => reads,
    dispose: async () => {
      await pool.dispose();
    },
  };
}

async function openAndWatch(h: Harness): Promise<() => void> {
  // Subscribing is what turns the serve stream on, so a reader arriving mid-turn is the case
  // this exercises rather than an accident of the test.
  return h.pool.subscribe("s1", 0, () => {});
}

/**
 * The pool's coalesced re-read of the serve, fired and finished, for a test on fake time: the clock
 * moves by `REFRESH_COALESCE_MS` rather than that long passing for real. Everything else here is in
 * memory -- the serve's events and its fetches -- so `drained`, which is not a timer, finishes it.
 */
async function reread(): Promise<void> {
  await drained();
  jest.advanceTimersByTime(REFRESH_COALESCE_MS);
  await drained();
}

describe("the opencode pool, streaming a turn", () => {
  it("draws every delta as its own row, and reads the history once for the seed", async () => {
    const h = harness();
    const stop = await openAndWatch(h);
    const readsAfterSeed = h.historyReads();

    h.push({ type: "session.text.started", data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0 } });
    h.push({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, delta: "one " },
    });
    h.push({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, delta: "two" },
    });
    h.push({
      type: "session.text.ended",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, text: "one two" },
    });
    // The events reach the pool through an in-memory stream.
    await drained();

    const page = await h.pool.page("s1", 0, 10);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.id).toBe("opencode:msg-1");
    expect(page.events[0]?.phase).toBe("streaming");
    expect(page.events[0]?.blocks).toEqual([{ kind: "text", text: "one two" }]);
    // The whole turn, and not one read per delta.
    expect(h.historyReads()).toBe(readsAfterSeed);
    expect(page.runState).toBe("running");
    await stop();
    await h.dispose();
  });

  it("settles the streamed row in place when the step's read brings the durable message", async () => {
    jest.useFakeTimers();
    const h = harness();
    const stop = await openAndWatch(h);
    h.push({ type: "session.reasoning.started", data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0 } });
    h.push({
      type: "session.reasoning.delta",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, delta: "thinking" },
    });
    await drained();
    const streamed = await h.pool.page("s1", 0, 10);
    expect(streamed.events[0]?.blocks).toEqual([{ kind: "reasoning", text: "thinking" }]);

    // The step ends, so the serve answers the read with the message it wrote, tool part and all.
    h.settle([
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { id: "m", providerID: "opencode-go" },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "the answer" },
        ],
      } as unknown as SessionMessage,
    ]);
    h.push({ type: "session.step.ended", data: { sessionID: "s1", assistantMessageID: "msg-1", finish: "stop" } });
    await reread();

    const settled = await h.pool.page("s1", 0, 10);
    expect(settled.total).toBe(1);
    expect(settled.events[0]?.id).toBe("opencode:msg-1");
    expect(settled.events[0]?.phase).toBe("complete");
    expect(settled.events[0]?.blocks).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "text", text: "the answer" },
    ]);
    expect(settled.runState).toBe("idle");
    await stop();
    await h.dispose();
  });

  it("keeps a running row whole when a read draws it mid-write", async () => {
    // The serve inserts a message into its history while the step is still writing it, so a
    // refresh can name the running message with parts the deltas never mentioned. Measured on a
    // live turn: the row drew as a thinking line, went text-only at the next delta, and the
    // thinking came back when the step ended. The row a reader is following must not lose what
    // it already had.
    jest.useFakeTimers();
    const h = harness();
    const stop = await openAndWatch(h);
    h.settle([
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        agent: "build",
        model: { id: "m", providerID: "opencode-go" },
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "" },
        ],
      } as unknown as SessionMessage,
    ]);
    h.push({ type: "session.step.started", data: { sessionID: "s1", assistantMessageID: "msg-1" } });
    await reread();
    const drawn = await h.pool.page("s1", 0, 10);
    expect(drawn.events[0]?.blocks).toEqual([{ kind: "reasoning", text: "" }]);

    h.push({ type: "session.text.started", data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0 } });
    h.push({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, delta: "the answer" },
    });
    await drained();
    const streamed = await h.pool.page("s1", 0, 10);
    // The thinking line is still there, and the text joined it rather than replacing the row.
    expect(streamed.events[0]?.blocks).toEqual([
      { kind: "reasoning", text: "" },
      { kind: "text", text: "the answer" },
    ]);
    expect(streamed.total).toBe(1);
    await stop();
    await h.dispose();
  });

  it("forgets the running message, so a late event for it cannot overwrite the settled row", async () => {
    const h = harness([
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { id: "m", providerID: "opencode-go" },
        content: [{ type: "text", text: "the whole answer" }],
      } as unknown as SessionMessage,
    ]);
    const stop = await openAndWatch(h);
    // A delta that arrives after the read, for a message the serve already wrote whole.
    h.push({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "msg-1", ordinal: 0, delta: "stale" },
    });
    await drained();
    const page = await h.pool.page("s1", 0, 10);
    expect(page.events[0]?.blocks).toEqual([{ kind: "text", text: "the whole answer" }]);
    expect(page.events[0]?.phase).toBe("complete");
    await stop();
    await h.dispose();
  });

  it("announces a model switch, so an open stream learns it with no new message", async () => {
    // Measured 2026-09-26: a switch from the panel's own picker updated the TUI and left the
    // panel's footer on the previous model. The serve publishes `session.model.selected` and
    // the next `session.get` names the new model, but the message set is untouched -- so the
    // refresh published nothing, the per-envelope stamp had nothing to ride on, and the open
    // stream never heard. The announce is the envelope the stamp rides on.
    jest.useFakeTimers();
    const h = harness();
    const seen: TimelineEnvelope[] = [];
    // What the HTTP layer would stamp, read at the moment each envelope is published. Measured
    // 2026-10-11: the announce went out before the pool stored the new model, so it carried
    // the old one and the footer stayed on it, while `sessionModel` read right a tick later.
    const stamped: Array<string | null> = [];
    const stop = await h.pool.subscribe("s1", 0, (envelope) => {
      seen.push(envelope);
      stamped.push(h.pool.sessionModel("s1"));
    });
    await drained();
    expect(h.pool.sessionModel("s1")).toBe("opencode-go/m");
    const before = seen.length;

    h.setServeModel("m2");
    h.push({
      type: "session.model.selected",
      data: { sessionID: "s1", model: { providerID: "opencode-go", id: "m2" } },
    });
    await reread();
    expect(h.pool.sessionModel("s1")).toBe("opencode-go/m2");

    expect(seen.length).toBeGreaterThan(before);
    // The switch wrote no message, so the announcement carries no rows -- only the newer
    // sequence the HTTP layer stamps the model onto.
    expect(seen.at(-1)?.events).toEqual([]);
    expect(stamped.at(-1)).toBe("opencode-go/m2");
    await stop();
    await h.dispose();
  });
});
