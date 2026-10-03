import { expect, test } from 'bun:test';
import {
  SseTextParser,
  decodeDeltaData,
  mapAnthropicStreamEvent,
  requestsLongContext,
  subscribeToObserver,
} from "@/live/claudeNetworkSource";

test("SseTextParser splits data frames and tolerates split chunk boundaries", () => {
  const parser = new SseTextParser();
  expect(parser.push('id: 1\ndata: {"a":1}\n\nid: 2\nda')).toEqual([
    { data: '{"a":1}', id: "1" },
  ]);
  expect(parser.push('ta: {"b":2}\n\n')).toEqual([{ data: '{"b":2}', id: "2" }]);
});

test("SseTextParser drops comment-only blocks and joins multi-line data", () => {
  const parser = new SseTextParser();
  expect(parser.push(": ping\n\ndata: line1\ndata: line2\n\n")).toEqual([
    { data: "line1\nline2", id: undefined },
  ]);
});

test("decodeDeltaData decodes a plain base64 JSON payload", () => {
  const payload = '{"type":"ping"}';
  expect(decodeDeltaData(Buffer.from(payload, "utf8").toString("base64"))).toBe(payload);
});

test("decodeDeltaData decompresses a gzip content-encoded payload", () => {
  const payload = '{"type":"content_block_delta"}';
  const gzipSync = (Bun as unknown as { gzipSync(data: Uint8Array): Uint8Array }).gzipSync;
  const compressed = gzipSync(new TextEncoder().encode(payload));
  const base64 = Buffer.from(compressed).toString("base64");
  expect(decodeDeltaData(base64)).toBe(payload);
});

test("mapAnthropicStreamEvent normalizes the stream shapes", () => {
  expect(mapAnthropicStreamEvent({ type: "message_start", message: { id: "m1", model: "claude" } }))
    .toEqual({ kind: "message_start", message: { id: "m1", model: "claude" } });
  expect(mapAnthropicStreamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", name: "Bash" },
  }))
    .toEqual({ kind: "content_block_start", index: 0, contentBlock: { type: "tool_use", name: "Bash" } });
  expect(mapAnthropicStreamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hi" },
  }))
    .toEqual({ kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
  expect(mapAnthropicStreamEvent({ type: "message_stop" })).toEqual({ kind: "message_stop" });
  // Usage rides at the event's top level, not inside `delta`; the mapper must
  // read it there or the live meter never sees a turn's final usage.
  expect(mapAnthropicStreamEvent({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 100, output_tokens: 50 },
  }))
    .toEqual({ kind: "message_delta", stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } });
  expect(mapAnthropicStreamEvent({ type: "ping" })).toEqual({ kind: "ping" });
  expect(mapAnthropicStreamEvent({ type: "made_up" })).toBeNull();
});

test("requestsLongContext matches the beta by name, not by substring", () => {
  const list = (value: string) => [{ name: "anthropic-beta", value }];

  // The real header carries a dozen entries, including `context-management-2025-06-27`, so a
  // substring test for "context-" would call every session long-context.
  expect(requestsLongContext(list("claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24"))).toBe(true);
  expect(requestsLongContext(list("claude-code-20250219,context-management-2025-06-27"))).toBe(false);
  expect(requestsLongContext(list("Anthropic-Beta-Like,x-context-1m-2025-08-07"))).toBe(false);
});

test("requestsLongContext reads the header name case-insensitively, and survives junk", () => {
  expect(requestsLongContext([{ name: "Anthropic-Beta", value: " context-1m-2025-08-07 " }])).toBe(true);
  expect(requestsLongContext([{ name: "authorization", value: "context-1m-2025-08-07" }])).toBe(false);
  expect(requestsLongContext(undefined)).toBe(false);
  expect(requestsLongContext([null, 7, { name: "anthropic-beta" }])).toBe(false);
});

/**
 * A stand-in for proxy-agent's viewer API that records which stream resources were handed back.
 * `events` decides how the events request goes, so one fake covers the failure and the live case.
 */
function fakeObserver(events: "full" | "live") {
  const deleted: string[] = [];
  let created = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/v1/viewer/streams") {
        created += 1;
        return Response.json({ streamId: `stream-${created}` }, { status: 201 });
      }
      if (request.method === "DELETE") {
        deleted.push(pathname.slice("/v1/viewer/streams/".length));
        return new Response(null, { status: 204 });
      }
      if (events === "full") {
        return Response.json({ code: "OBSERVER_ERROR_CODE_STREAM_CAPACITY_REACHED" }, { status: 503 });
      }
      return new Response(
        new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": hi\n\n")); } }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { endpoint: new URL(`http://127.0.0.1:${server.port}`), deleted, stop: () => server.stop(true) };
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition() && waited < 2_000; waited += 10) await Bun.sleep(10);
}

// The 2026-10-02 pile-up: the stream was created, its events were refused because proxy-agent's
// feed subscriptions were full, and the resource sat in the registry for ten minutes per retry.
test("a stream whose events are refused is handed back", async () => {
  const observer = fakeObserver("full");
  try {
    await expect(subscribeToObserver(observer.endpoint, () => {}, () => {})).rejects.toThrow(
      "proxy observer events failed: HTTP 503",
    );
    await until(() => observer.deleted.length > 0);
    expect(observer.deleted).toEqual(["stream-1"]);
  } finally {
    observer.stop();
  }
});

test("a live stream is handed back when it is closed, and not before", async () => {
  const observer = fakeObserver("live");
  try {
    const subscription = await subscribeToObserver(observer.endpoint, () => {}, () => {});
    await Bun.sleep(50);
    expect(observer.deleted).toEqual([]);

    subscription.close();
    await subscription.closed;
    await until(() => observer.deleted.length > 0);
    expect(observer.deleted).toEqual(["stream-1"]);
  } finally {
    observer.stop();
  }
});
