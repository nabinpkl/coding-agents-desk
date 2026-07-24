import type { Server } from "bun";
import { state, type OpenStream } from "../transcripts/transcriptState.ts";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  ...CORS_HEADERS,
};

const SSE_HEADERS: ResponseInit["headers"] = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  ...CORS_HEADERS,
};

const SSE_HEARTBEAT_MS = 20_000;
const encoder = new TextEncoder();

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

export function startServerSentEventStream(
  request: Request,
  server: Server<undefined>,
  onStart: (write: (bytes: Uint8Array) => void) => (() => void) | void,
): Response {
  server.timeout(request, 0);

  let record: OpenStream | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (bytes: Uint8Array): void => {
        try {
          controller.enqueue(bytes);
        } catch {
          record?.teardown();
        }
      };
      const stopConsumer = onStart(write) ?? (() => {});
      const heartbeat = setInterval(
        () => write(encoder.encode(": ping\n\n")),
        SSE_HEARTBEAT_MS,
      );
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
