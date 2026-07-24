import {
  ensureIndexed,
  getEventCount,
  readEventRaw,
  readEvents,
  RawEventTooLargeError,
  subscribeEvents,
  type ActivityEvent,
} from "../transcripts/eventIndex.ts";
import { getSnapshot } from "../transcripts/transcriptWatcher.ts";
import {
  CORS_HEADERS,
  encodeServerSentEvent,
  jsonResponse,
  startServerSentEventStream,
} from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const RAW_EVENT_PATTERN =
  /^\/api\/sessions\/([a-f0-9-]{36})\/events\/(\d+)\/raw$/i;

function findSession(sessionId: string) {
  return getSnapshot().find((session) => session.sessionId === sessionId);
}

async function paginatedEvents(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<Response> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return jsonResponse({ error: "invalid sessionId" }, 400);
  }
  const session = findSession(sessionId);
  if (session === undefined) return jsonResponse({ error: "session not found" }, 404);
  const events = await readEvents(
    session.sessionId,
    session.transcriptPath,
    offset,
    limit,
  );
  return jsonResponse({
    events,
    total: getEventCount(session.sessionId),
  });
}

async function rawEvent(sessionId: string, eventIndex: number): Promise<Response> {
  const session = findSession(sessionId);
  if (session === undefined) return jsonResponse({ error: "session not found" }, 404);
  try {
    const raw = await readEventRaw(sessionId, eventIndex);
    if (raw === null) return jsonResponse({ error: "event not found" }, 404);
    return new Response(raw, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    if (error instanceof RawEventTooLargeError) {
      return jsonResponse(
        { error: error.message, byteCount: error.byteCount },
        413,
      );
    }
    throw error;
  }
}

export const handleSessionRoutes: RouteHandler = (request, url, server) => {
  const path = url.pathname;
  if (
    request.method === "GET" &&
    path.startsWith("/api/sessions/") &&
    path.endsWith("/events")
  ) {
    const sessionId = path.slice(
      "/api/sessions/".length,
      -"/events".length,
    );
    const offset = Math.max(
      0,
      Number(url.searchParams.get("offset") ?? 0) | 0,
    );
    const limit = Math.max(
      1,
      Math.min(500, Number(url.searchParams.get("limit") ?? 100) | 0),
    );
    return paginatedEvents(sessionId, offset, limit);
  }

  const rawEventMatch = RAW_EVENT_PATTERN.exec(path);
  if (request.method === "GET" && rawEventMatch !== null) {
    return rawEvent(rawEventMatch[1]!, Number(rawEventMatch[2]!));
  }

  if (
    request.method === "GET" &&
    path.startsWith("/api/sessions/") &&
    path.endsWith("/stream")
  ) {
    const sessionId = path.slice(
      "/api/sessions/".length,
      -"/stream".length,
    );
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return jsonResponse({ error: "invalid sessionId" }, 400);
    }
    const session = findSession(sessionId);
    if (session === undefined) return jsonResponse({ error: "session not found" }, 404);
    const after = Math.max(
      0,
      Number(url.searchParams.get("after") ?? 0) | 0,
    );
    return startServerSentEventStream(request, server, (write) => {
      let cancelled = false;
      let unsubscribe: (() => void) | null = null;
      void (async () => {
        await ensureIndexed(session.sessionId, session.transcriptPath);
        if (cancelled) return;
        const total = getEventCount(session.sessionId);
        if (after < total) {
          const backfill = await readEvents(
            session.sessionId,
            session.transcriptPath,
            after,
            total - after,
          );
          for (const event of backfill) {
            write(encodeServerSentEvent(event));
          }
        }
        if (!cancelled) {
          unsubscribe = subscribeEvents(
            session.sessionId,
            (event: ActivityEvent) => write(encodeServerSentEvent(event)),
          );
        }
      })().catch((error: unknown) => {
        console.error("agent feed stream failed", error);
        write(encodeServerSentEvent({
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    });
  }

  return undefined;
};
