// proxy-agent observer client + Anthropic stream decoding.
//
// This module owns everything about turning proxy-agent's observer API (the
// loopback HTTP/SSE surface at `AGENT_FEED_PROXY_OBSERVER_ENDPOINT`) into
// normalized Anthropic stream events for the claude live backend. It holds no
// session or projection state; `ClaudeLiveBackend` owns that.
//
// The observer emits, per captured `/v1/messages` SSE flow:
//   - `flowUpserted` with a `requestBody` reference (the POST payload, which
//     carries the claude `session_id`),
//   - `streamDeltaObserved {flowId, sequence, eventType, data(base64)}` where
//     `eventType` is already the Anthropic SSE event name and `data` is the
//     base64 of the event JSON payload (possibly content-encoded),
//   - `streamEnded {flowId}`.

import { config } from "../config.ts";

export interface ObserverFlow {
  flowId: string;
  authority?: unknown;
  path?: unknown;
  method?: unknown;
  protocol?: unknown;
  requestBody?: { value?: unknown; sizeBytes?: unknown };
  requestHeaders?: unknown;
}

export interface ObserverFlowUpserted {
  flow?: ObserverFlow;
}

export interface ObserverDelta {
  flowId?: unknown;
  sequence?: unknown;
  eventType?: unknown;
  data?: unknown;
}

export interface ObserverStreamEnded {
  flowId?: unknown;
}

export interface ObserverWebSocketMessage {
  flowId?: unknown;
  sequence?: unknown;
  direction?: unknown;
  kind?: unknown;
  data?: unknown;
}

export type ObserverEvent = {
  observedAt?: unknown;
  flowUpserted?: ObserverFlowUpserted;
  streamDeltaObserved?: ObserverDelta;
  websocketMessageObserved?: ObserverWebSocketMessage;
  streamEnded?: ObserverStreamEnded;
};

/** The observer filter: only Anthropic message streams, so we never parse anything else. */
export const OBSERVER_SSE_FILTER: Record<string, unknown> = {
  protocols: ["OBSERVED_PROTOCOL_SSE"],
  domains: ["api.anthropic.com", "a-api.anthropic.com"],
};

export interface ObserverSubscription {
  close(): void;
  /** Resolves when the underlying SSE stream tears down (error, end, or close). */
  closed: Promise<void>;
}

export interface SseEvent {
  data?: string;
  id?: string;
}

/** Incremental SSE parser for `data:` frames separated by a blank line. */
export class SseTextParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let separator: number;
    while ((separator = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const data: string[] = [];
      let id: string | undefined;
      for (const raw of block.split("\n")) {
        const line = raw.trimEnd();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("id:")) id = line.slice(3).trimStart();
      }
      if (data.length > 0) events.push({ data: data.join("\n"), id });
    }
    return events;
  }
}

/**
 * Opens one proxy-agent viewer stream (creating it first) and forwards each
 * decoded observer event to `onEvent`. `onError` fires on transport failure or
 * unexpected end-of-stream; `close()` tears the subscription down.
 */
export async function subscribeToObserver(
  endpoint: URL,
  onEvent: (event: ObserverEvent) => void,
  onError: (error: unknown) => void,
  signal?: AbortSignal,
  filter: Record<string, unknown> = OBSERVER_SSE_FILTER,
): Promise<ObserverSubscription> {
  const createdResponse = await fetch(new URL("/v1/viewer/streams", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filter }),
    signal,
  });
  if (!createdResponse.ok) {
    throw new Error(`proxy observer stream create failed: HTTP ${createdResponse.status}`);
  }
  const created = (await createdResponse.json()) as { streamId?: unknown };
  if (typeof created.streamId !== "string" || created.streamId.length === 0) {
    throw new Error("proxy observer stream create returned no streamId");
  }

  const eventsUrl = new URL(`/v1/viewer/streams/${created.streamId}/events`, endpoint);
  const eventsResponse = await fetch(eventsUrl, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!eventsResponse.ok || !eventsResponse.body) {
    throw new Error(`proxy observer events failed: HTTP ${eventsResponse.status}`);
  }

  const controller = new AbortController();
  const outerSignal = signal;
  const onAbort = (): void => controller.abort();
  outerSignal?.addEventListener("abort", onAbort, { once: true });

  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseTextParser();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (!frame.data) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (parsed && typeof parsed === "object") onEvent(parsed as ObserverEvent);
        }
      }
      if (!controller.signal.aborted) onError(new Error("proxy observer stream ended"));
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      outerSignal?.removeEventListener("abort", onAbort);
      resolveClosed();
    }
  })();

  return {
    close() {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
    closed,
  };
}

/** Fetches a retained request body and returns the claude `session_id` it names, if any. */
export async function fetchSessionIdFromBody(
  endpoint: URL,
  bodyReference: string,
): Promise<string | null> {
  const response = await fetch(new URL(`/v1/bodies/${bodyReference}`, endpoint), {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) return null;
  const text = await response.text();
  return extractSessionId(text);
}

/**
 * Reads `session_id` out of a captured `/v1/messages` request body. The Anthropic
 * request carries the local claude identity as a JSON-encoded string in the `user`
 * parameter (and, in recent harness versions, a literal top-level `user_id`), with
 * the shape `{"device_id":..., "account_uuid":..., "session_id":...}`. That
 * `session_id` is the same id agent-feed keys claude sessions by (the transcript
 * basename), which is what makes network flows correlatable to sessions.
 */
export interface RequestMetadata {
  sessionId: string | null;
  toolResults: ToolResultItem[];
}

export interface ToolResultItem {
  toolUseId?: string;
  text: string;
}

/** Fetches a retained request body and returns the claude session id and any
 *  `tool_result` payloads it carries in its final user message. */
export async function fetchRequestMetadata(
  endpoint: URL,
  bodyReference: string,
): Promise<RequestMetadata> {
  const response = await fetch(new URL(`/v1/bodies/${bodyReference}`, endpoint), {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) return { sessionId: null, toolResults: [] };
  const text = await response.text();
  return { sessionId: extractSessionId(text), toolResults: extractToolResults(text) };
}

/**
 * Reads tool results out of a `/v1/messages` request body. When a model calls a
 * tool, the harness runs it and then sends the NEXT request with the result as
 * a `user` message containing `tool_result` content blocks -- so the result is
 * not in the streamed response, it rides in the request of the follow-up turn.
 */
export function extractToolResults(requestBody: string): ToolResultItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const messages = (parsed as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object" || Array.isArray(last)) return [];
  const message = last as Record<string, unknown>;
  if (message.role !== "user") return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const results: ToolResultItem[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const text = toolResultText(block.content);
    if (text.length > 0 || toolUseId) results.push({ toolUseId, text });
  }
  return results;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const sub of content) {
      if (typeof sub === "string") {
        out += sub;
      } else if (sub && typeof sub === "object") {
        const s = sub as Record<string, unknown>;
        if (typeof s.text === "string") out += s.text;
      }
    }
    return out;
  }
  return "";
}

/** Reads the Anthropic identity string out of the raw body (first user_id literal). */
export function extractSessionId(requestBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const topLevelUserId = typeof obj.user_id === "string" ? obj.user_id : null;
    const candidate = topLevelUserId ?? candidateIdentity(obj.user);
    if (candidate !== null) {
      const sessionId = sessionIdFromJsonEncodedIdentity(candidate);
      if (sessionId) return sessionId;
    }
  }
  // Fallback: the identity string does not reliably sit at the top level across
  // harness versions (it can ride inside a system block or a tool payload), so
  // find the first `user_id` string literal anywhere in the raw body, unescape
  // it as a JSON string, and read `session_id` from it.
  const match = /"user_id"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(requestBody);
  if (match) {
    let inner: string;
    try {
      inner = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
    return sessionIdFromJsonEncodedIdentity(inner);
  }
  return null;
}

function sessionIdFromJsonEncodedIdentity(value: string): string | null {
  let identity: unknown;
  try {
    identity = JSON.parse(value);
  } catch {
    return null;
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const sessionId = (identity as Record<string, unknown>).session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function candidateIdentity(user: unknown): string | null {
  if (typeof user === "string") return user;
  if (!user || typeof user !== "object") return null;
  const record = user as Record<string, unknown>;
  if (typeof record.user_id === "string") return record.user_id;
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object") {
    const nested = metadata as Record<string, unknown>;
    if (typeof nested.user_id === "string") return nested.user_id;
  }
  return null;
}

/**
 * Decodes a `streamDeltaObserved.data` value. `data` is the base64 of the SSE
 * payload, which proxy-agent preserves content-encoded, so gzip/br are sniffed
 * by magic bytes rather than trusted header state we do not carry here.
 */
export function decodeDeltaData(base64Data: string): string {
  const bytes = Buffer.from(base64Data, "base64");
  const decoded = sniffAndDecompress(bytes);
  return new TextDecoder().decode(decoded);
}

function sniffAndDecompress(bytes: Uint8Array): Uint8Array {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (bytes.length >= 2 && first === 0x1f && second === 0x8b) {
    try {
      return Bun.gunzipSync(new Uint8Array(bytes));
    } catch {
      return bytes;
    }
  }
  if (bytes.length >= 2 && (first & 0x0f) === 0x08 && (first >> 4) <= 7) {
    try {
      return Bun.inflateSync(new Uint8Array(bytes));
    } catch {
      return bytes;
    }
  }
  return bytes;
}

export interface AnthropicMessage {
  id?: unknown;
  model?: unknown;
  usage?: unknown;
}

export interface AnthropicContentBlock {
  type?: unknown;
  name?: unknown;
  text?: unknown;
  thinking?: unknown;
}

export interface AnthropicDelta {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  partial_json?: unknown;
}

export type AnthropicStreamEvent =
  | { kind: "message_start"; message: AnthropicMessage }
  | { kind: "content_block_start"; index: number; contentBlock: AnthropicContentBlock }
  | { kind: "content_block_delta"; index: number; delta: AnthropicDelta }
  | { kind: "content_block_stop"; index: number }
  | { kind: "message_delta"; stopReason?: unknown; usage?: unknown }
  | { kind: "message_stop" }
  | { kind: "ping" }
  | { kind: "error" };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asIndex(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Normalizes one decoded Anthropic stream event into the small union the live
 * backend applies. Unknown event types return null so a future stream shape
 * degrades to "no delta" rather than throwing.
 */
export function mapAnthropicStreamEvent(payload: unknown): AnthropicStreamEvent | null {
  const obj = asObject(payload);
  switch (obj.type) {
    case "message_start":
      return { kind: "message_start", message: asObject(obj.message) };
    case "content_block_start":
      return {
        kind: "content_block_start",
        index: asIndex(obj.index),
        contentBlock: asObject(obj.content_block),
      };
    case "content_block_delta":
      return {
        kind: "content_block_delta",
        index: asIndex(obj.index),
        delta: asObject(obj.delta) as AnthropicDelta,
      };
    case "content_block_stop":
      return { kind: "content_block_stop", index: asIndex(obj.index) };
    case "message_delta": {
      const delta = asObject(obj.delta);
      return { kind: "message_delta", stopReason: delta.stop_reason, usage: delta.usage };
    }
    case "message_stop":
      return { kind: "message_stop" };
    case "ping":
      return { kind: "ping" };
    case "error":
      return { kind: "error" };
    default:
      return null;
  }
}

export function claudeLiveReconnectDelay(attempt: number): number {
  const exponent = Math.min(attempt, 10);
  const delay = config.claudeLiveReconnectMs * 2 ** exponent;
  return Math.min(delay, config.claudeLiveReconnectMaxMs);
}
