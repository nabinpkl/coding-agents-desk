import { describe, expect, test } from "bun:test";
import {
  CODECX_OBSERVER_FILTER,
  CODECX_RESPONSES_AUTHORITY,
  CODECX_RESPONSES_PATH,
  decodeWebSocketMessage,
  extractCodexSessionId,
  mapCodexMessage,
  type ObservedRequestHeader,
} from "./codexNetworkSource.ts";

function header(name: string, value: string): ObservedRequestHeader {
  return { name, value };
}

describe("extractCodexSessionId", () => {
  test("reads the session-id header", () => {
    expect(extractCodexSessionId([
      header("session-id", "019fe292-5466-7393-b931-8bf0c2cece82"),
      header("thread-id", "019fe292-5466-7393-b931-8bf0c2cece82"),
    ])).toBe("019fe292-5466-7393-b931-8bf0c2cece82");
  });

  test("falls back to thread-id when session-id is absent", () => {
    expect(extractCodexSessionId([
      header("thread-id", "019fe292-5466-7393-b931-8bf0c2cece82"),
    ])).toBe("019fe292-5466-7393-b931-8bf0c2cece82");
  });

  test("strips the window suffix from x-codex-window-id", () => {
    expect(extractCodexSessionId([
      header("x-codex-window-id", "019fe292-5466-7393-b931-8bf0c2cece82:0"),
    ])).toBe("019fe292-5466-7393-b931-8bf0c2cece82");
  });

  test("returns null when no codex identity header is present", () => {
    expect(extractCodexSessionId([
      header("user-agent", "Codex Desktop/0.147.0-alpha.6.5"),
    ])).toBeNull();
    expect(extractCodexSessionId(undefined)).toBeNull();
    expect(extractCodexSessionId([])).toBeNull();
  });
});

describe("decodeWebSocketMessage", () => {
  test("decodes base64 UTF-8 message data", () => {
    const payload = JSON.stringify({ type: "ack", ack_id: "x" });
    expect(decodeWebSocketMessage(Buffer.from(payload, "utf8").toString("base64"))).toBe(payload);
  });
});

describe("mapCodexMessage", () => {
  test("normalizes the responses-API message types the desktop app sends", () => {
    expect(mapCodexMessage({ type: "response.create", input: [] })).toMatchObject({ kind: "response_create" });
    expect(mapCodexMessage({ type: "response.created" })).toMatchObject({ kind: "response_created" });
    expect(mapCodexMessage({ type: "response.in_progress" })).toMatchObject({ kind: "response_in_progress" });
    expect(mapCodexMessage({ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } }))
      .toMatchObject({ kind: "output_item_added" });
    expect(mapCodexMessage({ type: "response.output_text.delta", item_id: "msg_1", delta: "x" }))
      .toMatchObject({ kind: "output_text_delta", itemId: "msg_1", delta: "x" });
    expect(mapCodexMessage({ type: "response.output_text.done", item_id: "msg_1", text: "full" }))
      .toMatchObject({ kind: "output_text_done", itemId: "msg_1", text: "full" });
    expect(mapCodexMessage({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "t" }))
      .toMatchObject({ kind: "reasoning_summary_text_delta" });
    expect(mapCodexMessage({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" }))
      .toMatchObject({ kind: "function_call_arguments_done" });
    expect(mapCodexMessage({ type: "response.completed", response: {} })).toMatchObject({ kind: "response_completed" });
    expect(mapCodexMessage({ type: "ping" })).toMatchObject({ kind: "ping" });
    expect(mapCodexMessage({ type: "pong" })).toMatchObject({ kind: "pong" });
  });

  test("returns null for unknown shapes instead of throwing", () => {
    expect(mapCodexMessage({ type: "responses.whatever_new" })).toBeNull();
    expect(mapCodexMessage("not an object")).toBeNull();
    expect(mapCodexMessage(undefined)).toBeNull();
  });
});

describe("CODECX_OBSERVER_FILTER", () => {
  test("pins the websocket + chatgpt.com filter", () => {
    expect(CODECX_OBSERVER_FILTER).toEqual({
      protocols: ["OBSERVED_PROTOCOL_WEBSOCKET"],
      domains: ["chatgpt.com"],
    });
  });

  test("pins the codex responses endpoint identity", () => {
    expect(CODECX_RESPONSES_AUTHORITY).toBe("chatgpt.com");
    expect(CODECX_RESPONSES_PATH).toBe("/backend-api/codex/responses");
  });
});
