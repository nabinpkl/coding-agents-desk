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
//   - `streamEnded {flowId}`,
//   - `recordsDropped {firstMissingSequence, lastMissingSequence, droppedRecordCount}`
//     when its own capture pipeline could not keep up, which says the mirror is now
//     wrong rather than merely behind,
//   - `captureHealthChanged {health}` when the capture itself starts, stops or dies,
//     which is how a flow whose capture died learns it will never end on its own.

import { config } from "@/config/config";
import { noteRateLimitHeaders, readingTimeMs } from "@/usage/claudeLiveQuota";

export interface ObserverFlow {
  flowId: string;
  /** The capture that recorded this flow; it changes whenever proxy-agent restarts its capture. */
  sourceId?: unknown;
  authority?: unknown;
  path?: unknown;
  method?: unknown;
  protocol?: unknown;
  requestBody?: { value?: unknown; sizeBytes?: unknown };
  requestHeaders?: unknown;
  /**
   * When the API began this request, as an ISO timestamp.
   *
   * The rate-limit headers below are stamped at that moment rather than at completion, so this is
   * the clock those readings belong to. Flows do not complete in the order they started -- a long
   * turn finishes after several short ones that began later -- and the observer replays its
   * retained flows out of order entirely, so ordering them by arrival puts an older number last.
   */
  startedAt?: unknown;
  /**
   * The response's headers, which is where Anthropic publishes the account's rate-limit meters
   * (`anthropic-ratelimit-unified-5h-utilization` and its siblings).
   *
   * Modelled here even though the live mirror itself has no use for them: they are the only live
   * source of those numbers on this machine, and the observer is the only place they are legible.
   * `usage/claudeLiveQuota.ts` reads them off this field.
   */
  responseHeaders?: unknown;
}

/**
 * Whether this request asked for the million-token context, read off its own `anthropic-beta` list.
 *
 * The authority for a live turn, and better than anything in the body: the model field carries the
 * API's id (`claude-opus-5`), which is the same string whichever tier the harness picked, while the
 * tier itself is spelled `[1m]` only in the CLI's own model id and only in the transcript.
 *
 * Measured 2026-09-14 against the running proxy observer: `claude -p --model claude-opus-5` sent
 * six flows with no `context-1m-` beta, `--model 'claude-opus-5[1m]'` sent six with it, and every
 * other session observed in the same window was internally consistent across all of its flows.
 * The beta list also carries a dozen unrelated entries, so this matches the one name rather than
 * testing for a substring of the whole header.
 */
export function requestsLongContext(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const { name, value } = header as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || name.toLowerCase() !== "anthropic-beta") continue;
    if (typeof value !== "string") continue;
    if (value.split(",").some((beta) => beta.trim().toLowerCase().startsWith("context-1m-"))) {
      return true;
    }
  }
  return false;
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

/**
 * The observer saying IT lost records, before they ever reached this process.
 *
 * Not an error of ours and not recoverable from here: the gap is in what the capture pipeline
 * kept, so the deltas it names are gone. It is modelled because the alternative is a live message
 * that stops mid-sentence with nothing anywhere saying why -- the durable transcript fills the hole
 * in seconds, and until then the only honest account of the difference is this event.
 */
export interface ObserverRecordsDropped {
  sourceId?: unknown;
  firstMissingSequence?: unknown;
  lastMissingSequence?: unknown;
  droppedRecordCount?: unknown;
}

/**
 * proxy-agent's capture changing state: `lifecycle` is `CAPTURE_LIFECYCLE_RUNNING` and its
 * siblings, `sourceId` the capture it describes. Sent on every viewer stream whatever its filter,
 * first in the opening snapshot and then whenever it changes.
 */
export interface ObserverCaptureHealth {
  lifecycle?: unknown;
  sourceId?: unknown;
  failureCategory?: unknown;
}

export type ObserverEvent = {
  observedAt?: unknown;
  flowUpserted?: ObserverFlowUpserted;
  streamDeltaObserved?: ObserverDelta;
  websocketMessageObserved?: ObserverWebSocketMessage;
  streamEnded?: ObserverStreamEnded;
  recordsDropped?: ObserverRecordsDropped;
  captureHealthChanged?: { health?: ObserverCaptureHealth };
};

/** One dropped-record report as a log line: how many, and which capture sequences are missing. */
export function describeRecordsDropped(dropped: ObserverRecordsDropped): string {
  const count = Number(dropped.droppedRecordCount);
  const records = Number.isFinite(count) && count > 0 ? count : 1;
  return (
    `agent-feed-claude-live-observer-records-dropped: records=${records}` +
    ` sequences=${String(dropped.firstMissingSequence ?? "?")}` +
    `..${String(dropped.lastMissingSequence ?? "?")}`
  );
}

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

/** How long a release may take; it runs at shutdown too, when the caller's own signal is spent. */
const RELEASE_TIMEOUT_MS = 2_000;

/**
 * Hands a stream resource back to proxy-agent.
 *
 * Its registry holds 64 resources and frees one only after ten minutes with no activity, so a
 * resource left behind costs a slot for ten minutes. That is cheap once and not cheap on a retry
 * loop: on 2026-10-02 every 30s retry created a resource, failed to open its events stream because
 * proxy-agent's 32 feed subscriptions were full, and left the resource behind -- two a retry,
 * forty per ten minutes, until creating failed too. A 404 is a resource proxy-agent already let
 * go of, which is the outcome this wanted.
 */
async function releaseObserverStream(endpoint: URL, streamId: string): Promise<void> {
  try {
    const response = await fetch(new URL(`/v1/viewer/streams/${streamId}`, endpoint), {
      method: "DELETE",
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      console.error(`proxy-observer-stream-release-failed: stream=${streamId} HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`proxy-observer-stream-release-failed: stream=${streamId} ${String(error)}`);
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

  // From here the resource is ours, and every way out of this function hands it back: a failed
  // events request below, and the stream's end, error or close in the reader's `finally`.
  const streamId = created.streamId;
  const eventsUrl = new URL(`/v1/viewer/streams/${streamId}/events`, endpoint);
  let eventsResponse: Response;
  try {
    eventsResponse = await fetch(eventsUrl, {
      headers: { accept: "text/event-stream" },
      signal,
    });
  } catch (error) {
    void releaseObserverStream(endpoint, streamId);
    throw error;
  }
  if (!eventsResponse.ok || !eventsResponse.body) {
    void releaseObserverStream(endpoint, streamId);
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
          if (!parsed || typeof parsed !== "object") continue;
          const event = parsed as ObserverEvent;
          // Read here rather than in the backend, and before any of the mirror's own filtering:
          // the account's rate-limit meters ride on the response headers of ANY Anthropic call,
          // including the flows the mirror drops for having no request body to bind. They are a
          // fact about the account rather than about a session, so the one subscriber that sees
          // every flow is the right place to notice them (`usage/claudeLiveQuota.ts`).
          // Stamped with the flow's own start rather than with now: these readings are taken
          // when the API begins a request, and flows neither complete nor replay in that order.
          const flow = event.flowUpserted?.flow;
          noteRateLimitHeaders(flow?.responseHeaders, readingTimeMs(flow?.startedAt, Date.now()));
          onEvent(event);
        }
      }
      if (!controller.signal.aborted) onError(new Error("proxy observer stream ended"));
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      outerSignal?.removeEventListener("abort", onAbort);
      void releaseObserverStream(endpoint, streamId);
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
  if (bytes.length >= 2 && (first & 0x0f) === 0x08 && first >> 4 <= 7) {
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
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
        delta: asObject(obj.delta),
      };
    case "content_block_stop":
      return { kind: "content_block_stop", index: asIndex(obj.index) };
    case "message_delta": {
      const delta = asObject(obj.delta);
      // `usage` rides at the event's top level on the wire, not inside `delta`.
      return { kind: "message_delta", stopReason: delta.stop_reason, usage: obj.usage };
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

/** One vendor's side of the observer subscription that `runObserverLoop` keeps open. */
export interface ObserverLoop {
  /** Names the log lines, `agent-feed-<vendor>-live...`. */
  vendor: "claude" | "codex";
  endpoint: URL;
  filter?: Record<string, unknown>;
  signal?: AbortSignal;
  disposed: () => boolean;
  onEvent: (event: ObserverEvent) => void;
  onError: (error: unknown) => void;
  onSubscription: (subscription: ObserverSubscription) => void;
  reconnectDelay: (attempt: number) => number;
  /** After a subscription closed or failed to open, before waiting to reconnect. */
  onConnectionEnded?: () => void;
}

/** Holds an observer subscription open until disposed, reconnecting with backoff whenever it ends. */
export async function runObserverLoop(loop: ObserverLoop): Promise<void> {
  const tag = `agent-feed-${loop.vendor}-live`;
  let attempt = 0;
  while (!loop.disposed()) {
    try {
      const subscription = await subscribeToObserver(
        loop.endpoint,
        loop.onEvent,
        (error) => {
          loop.onError(error);
          if (!loop.disposed()) console.error(`${tag}-observer-error: ${String(error)}`);
        },
        loop.signal,
        loop.filter,
      );
      loop.onSubscription(subscription);
      attempt = 0;
      await subscription.closed;
      if (!loop.disposed()) console.log(`${tag}-observer-stream-ended`);
    } catch (error) {
      if (!loop.disposed()) {
        loop.onError(error);
        console.error(`${tag}-observer-connect-failed: ${String(error)}`);
      }
    }
    if (loop.disposed()) break;
    loop.onConnectionEnded?.();
    const delay = loop.reconnectDelay(attempt++);
    console.log(`${tag}: reconnecting in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
