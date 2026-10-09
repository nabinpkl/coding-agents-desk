import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import type { ObserverEvent } from "@/live/claudeNetworkSource";
import {
  delta,
  ended,
  flowEvent,
  flush,
  startFixture,
  LONG_CONTEXT_BETAS,
  ORDINARY_BETAS,
  type FixtureServer,
} from "@/live/fixtures/claudeLiveFixture";

describe("ClaudeLiveBackend ingest", () => {
  let fixture: FixtureServer;
  let backend: ClaudeLiveBackend;
  const sessionId = "sess-b1";

  beforeAll(async () => {
    fixture = startFixture();
    backend = new ClaudeLiveBackend(fixture.url, true, 8);
    // Feed the full lifecycle of one message.
    backend.acceptObserverEvent(flowEvent("f1", "/v1/messages", "api.anthropic.com", "b1"));
    backend.acceptObserverEvent(delta("f1", {
      type: "message_start",
      message: { id: "msg_123", model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }));
    backend.acceptObserverEvent(delta("f1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("f1"));
    await flush(160);
  });

  afterAll(async () => {
    await backend.dispose();
    fixture.stop();
  });

  test("binds the flow to its request session_id and mirrors the streaming message", async () => {
    const page = await backend.page(sessionId, 0, 10, "nice");
    expect(page.mode).toBe("nice");
    expect(page.total).toBe(1);
    const event = page.events[0]!;
    expect(event.type).toBe("assistant");
    expect(event.phase).toBe("complete");
    expect(event.blocks[0]!.kind).toBe("text");
    expect(event.blocks[0]!.text).toBe("Hello world");
    expect(event.revision).toBeGreaterThan(0);
    expect(page.sequence).toBeGreaterThan(0);
  });

  test("tracks context-window occupancy from message usage", () => {
    const usage = backend.sessionUsage(sessionId);
    expect(usage?.current).toBe(10);
    expect(usage?.model).toBe("claude-haiku-4-5");
  });

  test("raw and nice both serve the same live events", async () => {
    const nice = await backend.page(sessionId, 0, 10, "nice");
    const raw = await backend.page(sessionId, 0, 10, "raw");
    expect(raw.mode).toBe("raw");
    expect(raw.total).toBe(nice.total);
    expect(raw.events[0]!.blocks[0]!.text).toBe("Hello world");
    expect(raw.events[0]!.otherModeIndex).toBe(raw.events[0]!.index);
  });

  test("message_delta usage stamps the assistant row with the cache badge", async () => {
    const probe = new ClaudeLiveBackend(fixture.url, true, 8);
    const probeSession = "sess-cache";
    probe.acceptObserverEvent(flowEvent("fc", "/v1/messages", "api.anthropic.com", "cache"));
    probe.acceptObserverEvent(delta("fc", {
      type: "message_start",
      message: { id: "msg_cache", model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0 } },
    }));
    probe.acceptObserverEvent(delta("fc", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    probe.acceptObserverEvent(delta("fc", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cached turn" } }));
    probe.acceptObserverEvent(delta("fc", {
      type: "message_delta",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 400,
        output_tokens: 50,
      },
    }));
    probe.acceptObserverEvent(delta("fc", { type: "message_stop" }));
    probe.acceptObserverEvent(ended("fc"));
    await flush(160);

    const page = await probe.page(probeSession, 0, 10, "nice");
    expect(page.total).toBe(1);
    // Meter includes the cache: 100 + 200 + 400 + 50.
    expect(probe.sessionUsage(probeSession)?.current).toBe(750);
    // Badge: 400 of 700 prompt tokens came from the cache.
    expect(page.events[0]!.cacheHit).toEqual({ cached: 400, input: 700 });
    await probe.dispose();
  });

  test("a subagent's stream stays out of the parent's live view", async () => {
    // The bug this pins: a subagent's request carries the PARENT's session_id, so before this its
    // whole answer bound to the parent's projection and appeared in the parent's transcript --
    // while the parent was blocked on the tool call that started it. The parent's own message from
    // the fixture above is still there and is still the only one.
    const before = await backend.page(sessionId, 0, 10, "nice");
    backend.acceptObserverEvent(flowEvent("sub1", "/v1/messages", "api.anthropic.com", "subagent1"));
    backend.acceptObserverEvent(delta("sub1", {
      type: "message_start",
      message: { id: "msg_sub", model: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("sub1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("sub1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from the subagent" } }));
    backend.acceptObserverEvent(delta("sub1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("sub1"));
    await flush(160);
    const after = await backend.page(sessionId, 0, 10, "nice");
    expect(after.total).toBe(before.total);
    expect(JSON.stringify(after.events)).not.toContain("from the subagent");
  });

  test("a compaction summary stays out of the session it compacted", async () => {
    // The report this came from: a session compacted, and the feed's tail showed half the summary
    // instead of the compaction banner. The summariser runs under the session's own id and is not
    // a subagent, so nothing else was stopping it -- and it streams for minutes, right over the one
    // row that says the context was reset.
    const before = await backend.page(sessionId, 0, 10, "nice");
    backend.acceptObserverEvent(flowEvent("sum1", "/v1/messages", "api.anthropic.com", "summariser1"));
    backend.acceptObserverEvent(delta("sum1", {
      type: "message_start",
      message: { id: "msg_sum", model: "claude-haiku-4-5", usage: { input_tokens: 9, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("sum1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("sum1", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "This session is being continued from a previous conversation" },
    }));
    backend.acceptObserverEvent(delta("sum1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("sum1"));
    await flush(160);
    const after = await backend.page(sessionId, 0, 10, "nice");
    expect(after.total).toBe(before.total);
    expect(JSON.stringify(after.events)).not.toContain("continued from a previous conversation");
  });

  test("a compaction is announced while it runs and taken back when it ends", async () => {
    // The silence is the problem being solved. A compaction adds no transcript line until it
    // lands, and now streams nothing into the thread either, so two to four minutes of a large
    // context being rewritten look exactly like a turn that finished.
    const seen: Array<[string, boolean]> = [];
    const stop = backend.onCompaction((id, active) => seen.push([id, active]));
    expect(backend.compactionSummary(sessionId)).toBeNull();

    backend.acceptObserverEvent(flowEvent("sum2", "/v1/messages", "api.anthropic.com", "summariser1"));
    await flush(160);
    expect(backend.compactionSummary(sessionId)).not.toBeNull();
    expect(seen).toEqual([[sessionId, true]]);

    backend.acceptObserverEvent(ended("sum2"));
    await flush(40);
    expect(backend.compactionSummary(sessionId)).toBeNull();
    expect(seen).toEqual([[sessionId, true], [sessionId, false]]);

    // The observer announces every flow twice, and the second announcement arrives with the end.
    // A compaction's context is dropped seconds after it is recognised while the compaction runs
    // for minutes, so that repeat re-read the body and started the same compaction again after it
    // was over -- and the notice then stayed up until a fifteen-minute timer took it down.
    backend.acceptObserverEvent(flowEvent("sum2", "/v1/messages", "api.anthropic.com", "summariser1"));
    await flush(160);
    expect(backend.compactionSummary(sessionId)).toBeNull();
    expect(seen).toEqual([[sessionId, true], [sessionId, false]]);
    stop();
  });

  test("a compaction is still announced when its flow streamed hard before the bind", async () => {
    // A summariser's summary starts arriving before its own request body has been read back. The
    // buffer holding those deltas used to stop at 200 and throw the whole flow away, taking the
    // compaction with it. Kept as a test of the compaction rather than of the buffer: the
    // compaction is the fact that needs no context at all.
    const seen: Array<[string, boolean]> = [];
    const stop = backend.onCompaction((id, active) => seen.push([id, active]));
    backend.acceptObserverEvent(flowEvent("sum3", "/v1/messages", "api.anthropic.com", "summariser1"));
    for (let i = 0; i < 400; i++) {
      backend.acceptObserverEvent(delta("sum3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `chunk ${i}` },
      }));
    }
    await flush(160);
    backend.acceptObserverEvent(delta("sum3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }));
    expect(backend.compactionSummary(sessionId)).toBe(Array.from({ length: 400 }, (_, i) => `chunk ${i}`).join("") + "!");
    expect(seen).toEqual([[sessionId, true]]);
    backend.acceptObserverEvent(ended("sum3"));
    await flush(40);
    expect(backend.compactionSummary(sessionId)).toBeNull();
    stop();
  });

  test("unknown source session 404s on page", async () => {
    await expect(backend.page("sess-unknown", 0, 10, "nice")).rejects.toThrow();
  });

  test("non-message and non-anthropic flows are ignored", async () => {
    const probe = new ClaudeLiveBackend(fixture.url, true, 8);
    probe.acceptObserverEvent({ observedAt: new Date().toISOString(), flowUpserted: { flow: { flowId: "p", protocol: "OBSERVED_PROTOCOL_SSE", path: "/v1/environments/x/poll", authority: "api.anthropic.com" } } });
    probe.acceptObserverEvent({ observedAt: new Date().toISOString(), flowUpserted: { flow: { flowId: "q", protocol: "OBSERVED_PROTOCOL_SSE", path: "/v1/messages", authority: "example.com" } } });
    await expect(probe.page("sess-p", 0, 10, "nice")).rejects.toThrow();
    await probe.dispose();
  });

  test("a message arriving before the body bind is buffered, not dropped", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("f2", "/v1/messages", "api.anthropic.com", "b2"));
    // These arrive before the body fetch resolves.
    local.acceptObserverEvent(delta("f2", { type: "message_start", message: { id: "msg_200" } }));
    local.acceptObserverEvent(delta("f2", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(delta("f2", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
    local.acceptObserverEvent(delta("f2", { type: "message_stop" }));
    await flush(80);
    const page = await local.page("sess-b2", 0, 10, "nice");
    expect(page.events[0]!.blocks[0]!.text).toBe("ok");
    await local.dispose();
  });

  test("a whole turn that outruns its body fetch is mirrored, not thrown away", async () => {
    // The buffer a flow keeps until its session id arrives used to stop at 200 deltas, about
    // fifteen kilobytes, and a flow that reached it was deleted outright: a turn whose only sin
    // was streaming fast appeared nowhere, with nothing logged. 400 is past that and nowhere near
    // the byte bound that replaced it.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("fast", "/v1/messages", "api.anthropic.com", "fast1"));
    local.acceptObserverEvent(delta("fast", { type: "message_start", message: { id: "msg_fast" } }));
    local.acceptObserverEvent(delta("fast", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    for (let i = 0; i < 400; i++) {
      local.acceptObserverEvent(delta("fast", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }));
    }
    local.acceptObserverEvent(delta("fast", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-fast1", 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(page.events[0]!.blocks[0]!.text).toBe("x".repeat(400));
    expect(page.events[0]!.phase).toBe("complete");
    await local.dispose();
  });

  test("a flow announced before its body was retained binds on the announcement that carries it", async () => {
    // The observer announces one flow more than once and the first announcement does not always
    // carry the body. That one used to create a context and schedule its drop, and the
    // announcement that did carry the body was then refused for having a context already.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("late", "/v1/messages", "api.anthropic.com"));
    local.acceptObserverEvent(delta("late", { type: "message_start", message: { id: "msg_late" } }));
    local.acceptObserverEvent(delta("late", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(delta("late", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } }));
    await flush(40);
    local.acceptObserverEvent(flowEvent("late", "/v1/messages", "api.anthropic.com", "late1"));
    local.acceptObserverEvent(delta("late", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-late1", 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(page.events[0]!.blocks[0]!.text).toBe("late");
    await local.dispose();
  });

  test("a dropped observer connection finishes the message it was streaming", async () => {
    // The fixture has no viewer stream, so the subscription fails and the loop counts it as a
    // dropped connection, which is what the observer going away mid-message looks like here.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("cut", "/v1/messages", "api.anthropic.com", "cut1"));
    local.acceptObserverEvent(delta("cut", { type: "message_start", message: { id: "msg_cut" } }));
    local.acceptObserverEvent(delta("cut", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    await flush(160);
    expect((await local.page("sess-cut1", 0, 10, "nice")).events[0]!.phase).toBe("streaming");
    await local.start();
    await flush(160);
    expect((await local.page("sess-cut1", 0, 10, "nice")).events[0]!.phase).toBe("complete");
    await local.dispose();
  });

  test("a flow that ends before it binds, with no message_stop, still finishes its message", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("early", "/v1/messages", "api.anthropic.com", "early1"));
    local.acceptObserverEvent(delta("early", { type: "message_start", message: { id: "msg_early" } }));
    local.acceptObserverEvent(delta("early", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(ended("early"));
    await flush(160);
    expect((await local.page("sess-early1", 0, 10, "nice")).events[0]!.phase).toBe("complete");
    await local.dispose();
  });

  test("a streamed tool call carries the same summary its durable row will", async () => {
    // The row's header reads `summary`; without it a live Bash row said only "Bash".
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("fb", "/v1/messages", "api.anthropic.com", "bash1"));
    local.acceptObserverEvent(delta("fb", { type: "message_start", message: { id: "msg_bash" } }));
    local.acceptObserverEvent(delta("fb", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_bash", name: "Bash" },
    }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"git sta' } }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'tus --short"}' } }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_stop", index: 0 }));
    local.acceptObserverEvent(delta("fb", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-bash1", 0, 10, "nice");
    const block = page.events[0]!.blocks[0]!;
    expect(block.kind).toBe("tool_use");
    expect(block.input).toEqual({ command: "git status --short" });
    expect(block.summary).toBe("git status --short");
    await local.dispose();
  });

  test("tool results carried in the follow-up request body become user events", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("t1", "/v1/messages", "api.anthropic.com", "tool1"));
    await flush(80);
    const page = await local.page("sess-tool1", 0, 10, "nice");
    expect(page.total).toBe(1);
    const user = page.events[0]!;
    expect(user.type).toBe("user");
    expect(user.blocks[0]!.kind).toBe("tool_result");
    expect(user.blocks[0]!.callId).toBe("toolu_9");
    expect(user.blocks[0]!.preview).toBe("file.txt\nreadme.md");
    await local.dispose();
  });

  test("a tool-result row is dated when its turn was sent, not when the flow was announced", async () => {
    // The observer RESTAMPS `observedAt` on the flows it replays when a stream is created.
    // Measured 2026-09-16: all 18 flows in an opening burst carried the stream's own open time
    // while their own starts spanned the previous three hours, and six of them were completed
    // `/v1/messages` turns that still pass this path's gates. Dated by the event, a turn from two
    // minutes ago would republish as current -- and the panel resolves live against durable by
    // whichever is newer, so the wrong one would win.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    const startedAt = "2026-09-16T01:06:31.873Z";
    local.acceptObserverEvent(
      flowEvent("t2", "/v1/messages", "api.anthropic.com", "tool1", undefined, startedAt),
    );
    await flush(80);

    const page = await local.page("sess-tool1", 0, 10, "nice");
    expect(page.events[0]!.ts).toBe(Date.parse(startedAt));
    await local.dispose();
  });

  test("a flow the observer reported no start for falls back to when it was seen", async () => {
    // Being a few seconds out is the error this bounds, not one it introduces: a row with no
    // timestamp at all would sort to the epoch.
    const before = Date.now();
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("t3", "/v1/messages", "api.anthropic.com", "tool1"));
    await flush(80);

    const page = await local.page("sess-tool1", 0, 10, "nice");
    expect(page.events[0]!.ts).toBeGreaterThanOrEqual(before);
    await local.dispose();
  });

  test("subscribers receive upsert envelopes as deltas land", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("f3", "/v1/messages", "api.anthropic.com", "b3"));
    await flush(160);
    const envelopes: Array<{ kind: string; phase: string; text: string; revision: number }> = [];
    await local.subscribe("sess-b3", 0, (envelope) => {
      const event = envelope.events[0];
      envelopes.push({
        kind: envelope.kind,
        phase: event?.phase ?? "none",
        text: event ? (event.blocks[0]?.text ?? "") : "",
        revision: event?.revision ?? 0,
      });
    });
    local.acceptObserverEvent(delta("f3", { type: "message_start", message: { id: "msg_300" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } }));
    local.acceptObserverEvent(delta("f3", { type: "message_stop" }));
    await flush(40);
    const last = envelopes.at(-1);
    expect(last?.kind).toBe("upsert");
    expect(last?.text).toBe("ab");
    expect(last?.phase).toBe("complete");
    expect(last?.revision).toBeGreaterThanOrEqual(2);
    await local.dispose();
  });
});

describe("the context tier a live request asked for", () => {
  const fixture = startFixture();
  afterAll(() => fixture.stop());

  const usageOf = async (flowId: string, bodyRef: string, headers: { name: string; value: string }[]) => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent(flowId, "/v1/messages", "api.anthropic.com", bodyRef, headers));
    await flush(80);
    local.acceptObserverEvent(delta(flowId, {
      type: "message_start",
      message: { id: `msg_${flowId}`, model: "claude-opus-5", usage: { input_tokens: 500_000 } },
    }));
    local.acceptObserverEvent(delta(flowId, { type: "message_stop" }));
    await flush(40);
    const usage = local.sessionUsage(`sess-${bodyRef}`);
    await local.dispose();
    return usage;
  };

  test("reads the million-token window off the request's own beta list", async () => {
    // A captured request cannot name its tier: the model field says `claude-opus-5` whichever
    // window the harness is running. Resolving from it alone reported 200,000 for every 1M
    // session the moment it started streaming, and the panel takes the newer of the live and
    // durable snapshots, so that reading won while the session was being watched.
    const usage = await usageOf("ftier1", "tier1", [LONG_CONTEXT_BETAS]);

    expect(usage?.limit).toBe(1_000_000);
    // The model is what the API said, unchanged: the tier is not part of the id it returns.
    expect(usage?.model).toBe("claude-opus-5");
  });

  test("leaves an ordinary run on its own window", async () => {
    // Measured: `claude -p --model claude-opus-5` sends this list, with no `context-1m-` in it.
    const usage = await usageOf("ftier2", "tier2", [ORDINARY_BETAS]);

    expect(usage?.limit).toBe(200_000);
  });

  test("a flow whose headers never arrived does not shrink a session already known to be 1M", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("ftier3", "/v1/messages", "api.anthropic.com", "tier3", [LONG_CONTEXT_BETAS]));
    await flush(80);
    local.acceptObserverEvent(flowEvent("ftier4", "/v1/messages", "api.anthropic.com", "tier3"));
    await flush(80);
    local.acceptObserverEvent(delta("ftier4", {
      type: "message_start",
      message: { id: "msg_tier4", model: "claude-opus-5", usage: { input_tokens: 500_000 } },
    }));
    local.acceptObserverEvent(delta("ftier4", { type: "message_stop" }));
    await flush(40);

    // Every request of a session carries the same beta list, so a flow that named none is one this
    // mirror failed to read rather than a session that changed tier.
    expect(local.sessionUsage("sess-tier3")?.limit).toBe(1_000_000);
    await local.dispose();
  });
});
