import chokidar from "chokidar";
import {
  acquireIndex,
  discardIndexIfUnused,
  ensureIndexed,
  getEventCount,
  getSessionUsage,
  readEventRaw,
  readEvents,
  RawEventTooLargeError,
  releaseIndex,
  subscribeEvents,
  syncIndex,
  type ActivityEvent,
  type EventNotice,
} from "../transcripts/eventIndex.ts";
import {
  canonicalProjectPath,
  findSession,
  getSnapshot,
  getWatcherState,
  sessionSummaries,
  subscribeCatalog,
} from "../transcripts/transcriptCatalog.ts";
import type {
  EventMode,
  TranscriptSourceId,
} from "../transcripts/sources/transcriptTypes.ts";
import {
  encodeServerSentEvent,
  jsonResponse,
  startServerSentEventStream,
} from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const EVENT_ROUTE = /^\/api\/sessions\/(claude|codex)\/([0-9a-f-]{36})\/events$/i;
const RAW_EVENT_ROUTE =
  /^\/api\/sessions\/(claude|codex)\/([0-9a-f-]{36})\/events\/(\d+)\/raw$/i;
const STREAM_ROUTE = /^\/api\/sessions\/(claude|codex)\/([0-9a-f-]{36})\/stream$/i;

function sourceId(value: string): TranscriptSourceId {
  return value.toLowerCase() as TranscriptSourceId;
}

// Rejected rather than defaulted when unrecognized. A mode decides what an event
// index means, so silently falling back to raw for a typo would answer a nice-mode
// request with raw-mode indices, and every index in the response would point at the
// wrong line with nothing to signal it.
function modeQuery(url: URL): EventMode | null {
  const raw = url.searchParams.get("mode");
  if (raw === null) return "raw";
  return raw === "raw" || raw === "nice" ? raw : null;
}

function integerQuery(
  url: URL,
  name: string,
  defaultValue: number,
  maximum?: number,
): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return defaultValue;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return maximum === undefined ? value : Math.min(value, maximum);
}

async function selectedProject(url: URL): Promise<
  { projectPath: string } | { response: Response }
> {
  const requested = url.searchParams.get("projectPath");
  if (!requested) return { response: jsonResponse({ error: "invalid projectPath" }, 400) };
  const canonical = await canonicalProjectPath(requested);
  if (!canonical || canonical !== requested) {
    return { response: jsonResponse({ error: "invalid projectPath" }, 400) };
  }
  if (!getSnapshot().some((session) => session.project === canonical)) {
    return { response: jsonResponse({ error: "project not found" }, 404) };
  }
  return { projectPath: canonical };
}

async function sessionSnapshotResponse(url: URL): Promise<Response> {
  const selected = await selectedProject(url);
  if ("response" in selected) return selected.response;
  return jsonResponse({
    projectPath: selected.projectPath,
    sessions: await sessionSummaries(selected.projectPath),
  });
}

async function sessionSnapshotStream(
  request: Request,
  url: URL,
  server: Parameters<RouteHandler>[2],
): Promise<Response> {
  const selected = await selectedProject(url);
  if ("response" in selected) return selected.response;
  const projectPath = selected.projectPath;
  return startServerSentEventStream(request, server, (write) => {
    let generation = 0;
    let fingerprint: string | null = null;
    const push = (sessions = getSnapshot()): void => {
      const nextFingerprint = JSON.stringify(
        sessions
          .filter((session) => session.project === projectPath)
          .map((session) => [
            session.source,
            session.sessionId,
            session.lastEventAt,
            session.title,
          ]),
      );
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      const current = ++generation;
      void sessionSummaries(projectPath).then((sessions) => {
        if (current !== generation) return;
        write(encodeServerSentEvent({ projectPath, sessions }));
      }).catch((error) => {
        write(encodeServerSentEvent({
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    };
    push();
    const unsubscribe = subscribeCatalog(push);
    return () => {
      generation += 1;
      unsubscribe();
    };
  });
}

async function paginatedEvents(
  source: TranscriptSourceId,
  sessionId: string,
  offset: number,
  limit: number,
  mode: EventMode,
): Promise<Response> {
  const session = findSession(source, sessionId);
  if (!session) return jsonResponse({ error: "session not found" }, 404);
  acquireIndex(source, sessionId);
  try {
    const events = await readEvents(
      source,
      sessionId,
      session.transcriptPath,
      offset,
      limit,
      mode,
    );
    return jsonResponse({
      events,
      // Per mode, so the panel's paging arithmetic is in the same units as the
      // indices it just received.
      total: getEventCount(source, sessionId, mode),
      mode,
      usage: getSessionUsage(source, sessionId),
    });
  } finally {
    releaseIndex(source, sessionId);
  }
}

async function rawEvent(
  source: TranscriptSourceId,
  sessionId: string,
  eventIndex: number,
  mode: EventMode,
): Promise<Response> {
  const session = findSession(source, sessionId);
  if (!session) return jsonResponse({ error: "session not found" }, 404);
  acquireIndex(source, sessionId);
  try {
    const raw = await readEventRaw(
      source,
      sessionId,
      session.transcriptPath,
      eventIndex,
      mode,
    );
    if (raw === null) return jsonResponse({ error: "event not found" }, 404);
    return new Response(raw, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof RawEventTooLargeError) {
      return jsonResponse({ error: error.message, byteCount: error.byteCount }, 413);
    }
    throw error;
  } finally {
    releaseIndex(source, sessionId);
  }
}

function eventStream(
  request: Request,
  server: Parameters<RouteHandler>[2],
  source: TranscriptSourceId,
  sessionId: string,
  after: number,
  mode: EventMode,
): Response {
  const session = findSession(source, sessionId);
  if (!session) return jsonResponse({ error: "session not found" }, 404);
  return startServerSentEventStream(request, server, (write) => {
    let cancelled = false;
    let unsubscribeEvents: (() => void) | null = null;
    // Occupancy rides every event message instead of getting a message type of
    // its own: the thread stream already pushes once per event, so the panel's
    // meter goes live with no extra plumbing and the host decodes one optional
    // field. Read per write rather than captured, so it is never stale.
    const writeEvent = (event: ActivityEvent): void => {
      write(encodeServerSentEvent({
        ...event,
        mode,
        usage: getSessionUsage(source, sessionId),
      }));
    };
    // A stream is opened for ONE mode, so a machinery line is not an event this
    // subscriber has: it is skipped rather than renumbered, and the nice indices
    // stay contiguous exactly as the index assigned them.
    const onNotice = ({ event, niceIndex }: EventNotice): void => {
      if (mode === "raw") {
        writeEvent({ ...event, otherModeIndex: niceIndex });
        return;
      }
      if (niceIndex === null) return;
      writeEvent({ ...event, index: niceIndex, otherModeIndex: event.index });
    };
    acquireIndex(source, sessionId);
    const watcher = chokidar.watch(session.transcriptPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
    });
    const sync = (): void => {
      void syncIndex(source, sessionId, session.transcriptPath).catch((error) => {
        write(encodeServerSentEvent({
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    };
    watcher.on("add", sync);
    watcher.on("change", sync);
    watcher.on("error", (error) => {
      write(encodeServerSentEvent({ error: String(error) }));
    });
    void (async () => {
      await ensureIndexed(source, sessionId, session.transcriptPath);
      if (cancelled) {
        discardIndexIfUnused(source, sessionId);
        return;
      }
      const total = getEventCount(source, sessionId, mode);
      if (after < total) {
        const backfill = await readEvents(
          source,
          sessionId,
          session.transcriptPath,
          after,
          total - after,
          mode,
        );
        if (cancelled) {
          discardIndexIfUnused(source, sessionId);
          return;
        }
        for (const event of backfill) writeEvent(event);
      }
      unsubscribeEvents = subscribeEvents(source, sessionId, onNotice);
      await syncIndex(source, sessionId, session.transcriptPath);
      if (cancelled) discardIndexIfUnused(source, sessionId);
    })().catch((error) => {
      if (cancelled) {
        discardIndexIfUnused(source, sessionId);
        return;
      }
      write(encodeServerSentEvent({
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    return () => {
      cancelled = true;
      unsubscribeEvents?.();
      void watcher.close();
      releaseIndex(source, sessionId);
    };
  });
}

export const handleSessionRoutes: RouteHandler = (request, url, server) => {
  if (request.method !== "GET") return undefined;
  if (getWatcherState() !== "live") {
    return jsonResponse({ error: "inventory-not-ready" }, 503);
  }
  if (url.pathname === "/api/sessions") return sessionSnapshotResponse(url);
  if (url.pathname === "/api/sessions/stream") {
    return sessionSnapshotStream(request, url, server);
  }

  const mode = modeQuery(url);

  const eventMatch = EVENT_ROUTE.exec(url.pathname);
  if (eventMatch) {
    const offset = integerQuery(url, "offset", 0);
    const limit = integerQuery(url, "limit", 100, 500);
    if (offset === null || limit === null || limit < 1) {
      return jsonResponse({ error: "invalid pagination" }, 400);
    }
    if (mode === null) return jsonResponse({ error: "invalid mode" }, 400);
    return paginatedEvents(sourceId(eventMatch[1]!), eventMatch[2]!, offset, limit, mode);
  }

  const rawMatch = RAW_EVENT_ROUTE.exec(url.pathname);
  if (rawMatch) {
    if (mode === null) return jsonResponse({ error: "invalid mode" }, 400);
    return rawEvent(sourceId(rawMatch[1]!), rawMatch[2]!, Number(rawMatch[3]!), mode);
  }

  const streamMatch = STREAM_ROUTE.exec(url.pathname);
  if (streamMatch) {
    const after = integerQuery(url, "after", 0);
    if (after === null) {
      return jsonResponse({ error: "invalid after" }, 400);
    }
    if (mode === null) return jsonResponse({ error: "invalid mode" }, 400);
    return eventStream(
      request,
      server,
      sourceId(streamMatch[1]!),
      streamMatch[2]!,
      after,
      mode,
    );
  }

  if (url.pathname.startsWith("/api/sessions/")) {
    return jsonResponse({ error: "invalid source or sessionId" }, 400);
  }
  return undefined;
};
