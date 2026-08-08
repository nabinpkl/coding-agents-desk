// Codex desktop observer decoding.
//
// Codex Desktop streams each conversation over a persistent WebSocket to
// `chatgpt.com/backend-api/codex/responses` (the responses API over the
// `responses_websockets` transport). The observer delivers, per flow:
//   - `flowUpserted` with the request headers -- which carry the codex
//     `session-id` (same id the durable codex catalog keys threads by),
//   - `websocketMessageObserved {flowId, sequence, direction, kind, data}`
//     where `data` is the base64 of the raw UTF-8 JSON message,
//   - `streamEnded {flowId}` when the socket closes.
//
// This module owns turning those observer events into normalized codex
// responses-API messages for the codex live backend. It holds no session or
// projection state; `CodexLiveBackend` owns that.

import { decodeDeltaData } from "./claudeNetworkSource.ts";

/** The observer filter: codex desktop response sockets only, so we never parse anything else. */
export const CODECX_OBSERVER_FILTER: Record<string, unknown> = {
  protocols: ["OBSERVED_PROTOCOL_WEBSOCKET"],
  domains: ["chatgpt.com"],
};

export const CODECX_RESPONSES_PATH = "/backend-api/codex/responses";
export const CODECX_RESPONSES_AUTHORITY = "chatgpt.com";

/** Decodes a `websocketMessageObserved.data` value (base64 of the raw UTF-8 message). */
export function decodeWebSocketMessage(base64Data: string): string {
  // The observer bytes decode path also sniffs gzip/br; websocket frames are
  // carried plain, so this is a defensive passthrough.
  return decodeDeltaData(base64Data);
}

/** A captured request header pair, as carried by the observer's flow summary. */
export interface ObservedRequestHeader {
  name?: unknown;
  value?: unknown;
}

/**
 * Reads the codex session id out of a captured flow's request headers. Codex
 * Desktop sends `session-id`, `thread-id`, and `x-codex-window-id` (the window
 * id is the session id with a `:N` suffix); any of them identify the thread
 * agent-feed keys codex sessions by.
 */
export function extractCodexSessionId(headers: unknown): string | null {
  if (!Array.isArray(headers)) return null;
  const byName = new Map<string, string>();
  for (const header of headers) {
    if (typeof header?.name !== "string" || typeof header.value !== "string") continue;
    byName.set(header.name.toLowerCase(), header.value);
  }
  const direct = byName.get("session-id") ?? byName.get("thread-id");
  if (direct && direct.length > 0) return direct;
  const windowId = byName.get("x-codex-window-id");
  if (typeof windowId === "string" && windowId.length > 0) {
    const base = windowId.split(":", 1)[0] ?? "";
    if (base.length > 0) return base;
  }
  return null;
}

export type CodexMessageEvent =
  | { kind: "response_create"; model?: unknown; input: unknown }
  | { kind: "response_created" }
  | { kind: "response_in_progress" }
  | { kind: "output_item_added"; item: Record<string, unknown> }
  | { kind: "output_item_done"; item: Record<string, unknown> }
  | { kind: "output_text_delta"; itemId?: unknown; delta?: unknown }
  | { kind: "output_text_done"; itemId?: unknown; text?: unknown }
  | { kind: "reasoning_summary_text_delta"; itemId?: unknown; delta?: unknown }
  | { kind: "reasoning_summary_text_done"; itemId?: unknown; text?: unknown }
  | { kind: "function_call_arguments_delta"; itemId?: unknown; delta?: unknown }
  | { kind: "function_call_arguments_done"; itemId?: unknown; arguments?: unknown }
  | { kind: "response_completed"; response?: unknown }
  | { kind: "ack" }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "server_message" };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes one decoded codex responses-API message into the small union the
 * live backend applies. Unknown event types return null so a future stream
 * shape degrades to "no delta" rather than throwing.
 */
export function mapCodexMessage(payload: unknown): CodexMessageEvent | null {
  const obj = asObject(payload);
  switch (obj.type) {
    case "response.create":
      return { kind: "response_create", model: obj.model, input: obj.input };
    case "response.created":
      return { kind: "response_created" };
    case "response.in_progress":
      return { kind: "response_in_progress" };
    case "response.output_item.added":
      return { kind: "output_item_added", item: asObject(obj.item) };
    case "response.output_item.done":
      return { kind: "output_item_done", item: asObject(obj.item) };
    case "response.output_text.delta":
      return { kind: "output_text_delta", itemId: obj.item_id, delta: obj.delta };
    case "response.output_text.done":
      return { kind: "output_text_done", itemId: obj.item_id, text: obj.text };
    case "response.reasoning_summary_text.delta":
      return { kind: "reasoning_summary_text_delta", itemId: obj.item_id, delta: obj.delta };
    case "response.reasoning_summary_text.done":
      return { kind: "reasoning_summary_text_done", itemId: obj.item_id, text: obj.text };
    case "response.function_call_arguments.delta":
      return { kind: "function_call_arguments_delta", itemId: obj.item_id, delta: obj.delta };
    case "response.function_call_arguments.done":
      return { kind: "function_call_arguments_done", itemId: obj.item_id, arguments: obj.arguments };
    case "response.completed":
      return { kind: "response_completed", response: obj.response };
    case "ack":
      return { kind: "ack" };
    case "ping":
      return { kind: "ping" };
    case "pong":
      return { kind: "pong" };
    case "server_message":
      return { kind: "server_message" };
    default:
      return null;
  }
}
