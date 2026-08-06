import { expect, test } from "bun:test";
import {
  SseTextParser,
  decodeDeltaData,
  extractSessionId,
  extractToolResults,
  mapAnthropicStreamEvent,
} from "./claudeNetworkSource.ts";

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

test("extractSessionId reads a top-level user_id JSON string", () => {
  const body = JSON.stringify({
    user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-top" }),
  });
  expect(extractSessionId(body)).toBe("sess-top");
});

test("extractSessionId reads the user string parameter", () => {
  const body = JSON.stringify({
    user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-user" }),
  });
  expect(extractSessionId(body)).toBe("sess-user");
});

test("extractSessionId reads user.metadata.user_id", () => {
  const body = JSON.stringify({
    user: { metadata: { user_id: JSON.stringify({ session_id: "sess-meta" }) } },
  });
  expect(extractSessionId(body)).toBe("sess-meta");
});

test("extractSessionId finds a nested user_id by raw unescape", () => {
  const identity = JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-nested" });
  const body = JSON.stringify({
    model: "claude",
    messages: [{ role: "user", content: "hi" }],
    system: [{ type: "tool", payload: { user_id: identity } }],
  });
  expect(extractSessionId(body)).toBe("sess-nested");
});

test("extractSessionId returns null for bodies without identity", () => {
  expect(extractSessionId(JSON.stringify({ model: "claude" }))).toBeNull();
  expect(extractSessionId("not json")).toBeNull();
  expect(extractSessionId(JSON.stringify({ user_id: "not-json" }))).toBeNull();
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

test("extractToolResults reads tool_result blocks from the final user message", () => {
  const body = JSON.stringify({
    model: "claude",
    messages: [
      { role: "user", content: "head " },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42 lines of output" }] },
    ],
  });
  const results = extractToolResults(body);
  expect(results).toHaveLength(1);
  expect(results[0]!.toolUseId).toBe("toolu_1");
  expect(results[0]!.text).toBe("42 lines of output");
});

test("extractToolResults handles structured content and ignores non-tool turns", () => {
  const structured = JSON.stringify({
    model: "claude",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
    ],
  });
  expect(extractToolResults(structured)[0]!.text).toBe("ok");
  const prompt = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] });
  expect(extractToolResults(prompt)).toHaveLength(0);
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
  expect(mapAnthropicStreamEvent({ type: "ping" })).toEqual({ kind: "ping" });
  expect(mapAnthropicStreamEvent({ type: "made_up" })).toBeNull();
});
