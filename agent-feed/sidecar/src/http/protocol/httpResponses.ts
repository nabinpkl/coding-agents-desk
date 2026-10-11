import type { Server } from "bun";
import { state, type OpenStream } from "@/transcripts/transcriptState";

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
};

const SSE_HEADERS: ResponseInit["headers"] = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const SSE_HEARTBEAT_MS = 20_000;
const encoder = new TextEncoder();
const PING_BYTES = encoder.encode(": ping\n\n");

export const BYE_BYTES = encoder.encode('event: bye\ndata: "shutdown"\n\n');

export function encodeServerSentEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * The failure envelope the panel's own client reads.
 *
 * Shared rather than per-route, because the client tells a failure apart by `error.code` and
 * reports `error.message`: a route that answers `{ error: "..." }` with a bare string is read as
 * having sent no message at all, and its reason reaches the reader as "sidecar answered 400".
 */
export function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}

/**
 * `onStart` receives `write` and a `close`.
 *
 * Most streams here are endless -- a session's events, a task's output -- and end only when the
 * reader goes away, so they ignore `close`. A stream over a FINITE piece of work has to end
 * itself: leaving it open says "more is coming" to a reader that would otherwise wait, and to an
 * `EventSource` an ended stream is also the signal not to reconnect. Call it once the stream has
 * said everything it has to say, never synchronously inside `onStart` -- at that point the
 * teardown it closes over does not exist yet.
 */
export function startServerSentEventStream(
  request: Request,
  server: Server<undefined>,
  onStart: (
    write: (bytes: Uint8Array) => void,
    close: () => void,
  ) => (() => void) | void,
  options: {
    lagLimit?: number;
    /**
     * What a beat writes, and how often. Defaults to an SSE comment, which keeps proxies from
     * idling the connection out and is all most streams need. A stream whose reader must tell a
     * stalled connection from a quiet session passes a message instead: `EventSource` never
     * surfaces a comment, so a reader cannot time one.
     */
    heartbeat?: { bytes: Uint8Array; intervalMs: number };
  } = {},
): Response {
  server.timeout(request, 0);

  let record: OpenStream | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (bytes: Uint8Array): void => {
        // Bounded fan-out for live sources: a reader that falls more than
        // `lagLimit` events behind is closed with a typed notice instead of
        // buffering without bound in the controller queue.
        if (
          options.lagLimit !== undefined &&
          controller.desiredSize !== null &&
          controller.desiredSize < -options.lagLimit
        ) {
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { code: "stream-lag", message: "reader fell behind the live stream", retryable: true } })}\n\n`,
              ),
            );
          } catch {
            // controller is already closing; teardown below handles it.
          }
          teardown();
          return;
        }
        try {
          controller.enqueue(bytes);
        } catch {
          record?.teardown();
        }
      };
      const stopConsumer = onStart(write, () => teardown()) ?? (() => {});
      const beat = options.heartbeat ?? { bytes: PING_BYTES, intervalMs: SSE_HEARTBEAT_MS };
      const heartbeat = setInterval(() => write(beat.bytes), beat.intervalMs);
      let closed = false;
      const teardown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          stopConsumer();
        } catch (error) {
          console.error("agent feed stream consumer teardown failed", error);
        } finally {
          if (record !== null) state.openStreams.delete(record);
        }
        try {
          controller.close();
        } catch (error) {
          console.debug("agent feed stream was already closed", error);
        }
      };
      record = { controller, teardown };
      state.openStreams.add(record);

      if (request.signal.aborted) teardown();
      else request.signal.addEventListener("abort", teardown, { once: true });
    },
    cancel() {
      record?.teardown();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
