import {
  acquireIndex,
  discardIndexIfUnused,
  ensureIndexed,
  followTranscript,
  getEventCount,
  getSessionUsage,
  readEventRaw,
  readEvents,
  RawEventTooLargeError,
  releaseIndex,
  subscribeEvents,
  syncIndex,
  type EventNotice,
} from "@/transcripts/event-index/eventIndex";
import {
  canonicalProjectPath,
  findSession,
  getSnapshot,
  getWatcherState,
  sessionSummaries,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/transcriptCatalog";
import type {
  EventMode,
  TranscriptSourceId,
} from "@/transcripts/transcriptTypes";
import type { EventsPage, ForkSessionCommand, TimelineEnvelope } from "@agentdesk/agent-feed-wire";
import { createTimelineFollower } from "@/http/session-routes/timelineCheckpoint";
import {
  renameClaudeSession,
  SessionRenameInvalidError,
  SessionRenameNotFoundError,
  SessionRenameUnavailableError,
} from "@/transcripts/renameSession";
import {
  forkClaudeSession,
  SessionForkInvalidError,
  SessionForkNotFoundError,
} from "@/transcripts/forkSession";
import { WorktreeError } from "@/git/worktree";
import { errorResponse, jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import {
  LAST_COMPACTION_ROUTE,
  LAST_MESSAGE_ROUTE,
  lastCompactionResponse,
  lastMessageResponse,
} from "@/http/session-routes/forkAnchorRoutes";

const EVENT_ROUTE = /^\/api\/sessions\/(claude|codex)\/([0-9a-f-]{36})\/events$/i;
const RAW_EVENT_ROUTE =
  /^\/api\/sessions\/(claude|codex)\/([0-9a-f-]{36})\/events\/(\d+)\/raw$/i;
// Claude only, in the pattern rather than in a branch: Codex titles live in a database this does
// not write, so a Codex path here would be a 404 dressed as a route that exists.
const TITLE_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/title$/i;
// Claude only for a second reason on top of the title's: `--fork-session` is a Claude CLI flag,
// and Codex would silently resume the original transcript instead of branching from it.
const FORK_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/fork$/i;

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

async function sessionSnapshotResponse(
  url: URL,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): Promise<Response> {
  const selected = await selectedProject(url);
  if ("response" in selected) return selected.response;
  return jsonResponse({
    projectPath: selected.projectPath,
    sessions: sessionSummaries(selected.projectPath, resolveAgentSession),
  });
}

/**
 * One page of a transcript-backed session, or null when no such session is known.
 *
 * Exported because the composite timeline endpoint seeds its snapshot from the same
 * read: two ways to page one transcript is exactly the drift this arc is removing.
 */
export async function readTranscriptPage(
  source: TranscriptSourceId,
  sessionId: string,
  offset: number,
  limit: number,
  mode: EventMode,
): Promise<EventsPage | null> {
  const session = findSession(source, sessionId);
  if (!session) return null;
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
    return {
      events,
      // Per mode, so the panel's paging arithmetic is in the same units as the
      // indices it just received.
      total: getEventCount(source, sessionId, mode),
      mode,
      usage: getSessionUsage(source, sessionId),
      sequence: getEventCount(source, sessionId, mode),
      runState: "idle",
      queue: { steer: 0, followUp: 0 },
    };
  } finally {
    releaseIndex(source, sessionId);
  }
}

async function paginatedEvents(
  source: TranscriptSourceId,
  sessionId: string,
  offset: number,
  limit: number,
  mode: EventMode,
): Promise<Response> {
  const page = await readTranscriptPage(source, sessionId, offset, limit, mode);
  if (!page) return jsonResponse({ error: "session not found" }, 404);
  return jsonResponse(page);
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

/**
 * Follows one transcript-backed session from `after`, backfilling everything the
 * index already holds and then streaming rows as the file grows. Returns the
 * teardown, or null when no such session is known.
 *
 * Transport-free -- it hands envelopes to a callback rather than writing SSE -- so
 * the plain `/stream` route and the composite `/timeline` endpoint follow a
 * transcript through the same code rather than through two copies of the watcher,
 * the backfill arithmetic, and the mode-skipping rule.
 *
 * What it hands over is decided by `createTimelineFollower`, not here: rows while this
 * reader is keeping up, and a checkpoint when it is not. Both the backfill below and
 * the file growing later go through it, because being a window behind at the moment of
 * opening and falling a window behind afterwards are the same thing to a reader.
 */
export function subscribeTranscriptTimeline(
  source: TranscriptSourceId,
  sessionId: string,
  after: number,
  mode: EventMode,
  handlers: {
    onEnvelope: (envelope: TimelineEnvelope) => void;
    onError: (message: string) => void;
  },
): (() => void) | null {
  const session = findSession(source, sessionId);
  if (!session) return null;
  let cancelled = false;
  let unsubscribeEvents: (() => void) | null = null;
  const fail = (error: unknown): void => {
    handlers.onError(error instanceof Error ? error.message : String(error));
  };
  // Occupancy rides every envelope instead of getting a message type of its own: the
  // thread stream already writes whenever the record moves, so the panel's meter goes
  // live with no extra plumbing and the host decodes one optional field. Read per
  // write rather than captured, so it is never stale.
  const follower = createTimelineFollower({
    mode,
    // A transcript is only ever appended to, so an index means the same line before and after a
    // checkpoint and a reader keeps whatever they had paged in below it.
    stableIndices: true,
    usage: () => getSessionUsage(source, sessionId),
    emit: handlers.onEnvelope,
  });
  // A stream is opened for ONE mode, so a machinery line is not an event this
  // subscriber has: it is skipped rather than renumbered, and the nice indices
  // stay contiguous exactly as the index assigned them.
  const onNotice = ({ event, niceIndex }: EventNotice): void => {
    if (mode === "raw") {
      follower.offer({ ...event, otherModeIndex: niceIndex });
      return;
    }
    if (niceIndex === null) return;
    follower.offer({ ...event, index: niceIndex, otherModeIndex: event.index });
  };
  // The watch and the index reference are one thing here: the index is what this
  // reads and the watch is what keeps it current, and both are shared with every
  // other reader of the same transcript.
  const unfollow = followTranscript(source, sessionId, session.transcriptPath, fail);
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
      for (const event of backfill) follower.offer(event);
    }
    unsubscribeEvents = subscribeEvents(source, sessionId, onNotice);
    await syncIndex(source, sessionId, session.transcriptPath);
    if (cancelled) discardIndexIfUnused(source, sessionId);
  })().catch((error) => {
    if (cancelled) {
      discardIndexIfUnused(source, sessionId);
      return;
    }
    fail(error);
  });
  return () => {
    cancelled = true;
    // Before the unsubscribe, so a flush already queued for this microtask cannot write
    // to a subscriber that has left.
    follower.close();
    unsubscribeEvents?.();
    unfollow();
  };
}

/**
 * Renames one session, by asking the running session to rename itself.
 *
 * Deliberately NOT a `custom-title` record appended from outside: that moves the title and leaves
 * the address behind, and it puts a second writer on a file the CLI owns. `renameSession.ts` has
 * the whole argument.
 *
 * A POST rather than a PUT because the host relay admits GET and POST only, the same reason the
 * Bot detach endpoint is a POST.
 */
async function renameSession(
  sessionId: string,
  request: Request,
  rename: SessionRouteActions["rename"],
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid-request", "request body must be JSON", 400);
  }
  const title = (body as { title?: unknown } | null)?.title;
  if (typeof title !== "string") {
    return errorResponse("invalid-title", "a session title must be a string", 400);
  }
  try {
    return jsonResponse({ sessionId, title: await rename(sessionId, title) });
  } catch (error) {
    if (error instanceof SessionRenameInvalidError) {
      return errorResponse("invalid-title", error.message, 400);
    }
    if (error instanceof SessionRenameNotFoundError) {
      return errorResponse("session-not-found", error.message, 404);
    }
    // 409, not 400: nothing about the request was wrong, and the same request works once the
    // session is running or its composer is clear.
    if (error instanceof SessionRenameUnavailableError) {
      return errorResponse("rename-unavailable", error.message, 409);
    }
    throw error;
  }
}

/**
 * Forks one session into a new one, in its own pane.
 *
 * The source is the session in the PATH, which is the whole point of moving this off the Bot
 * endpoint: forking is something you do to a session, and a reader deciding to branch is looking
 * at a transcript rather than at a roster.
 */
async function forkSession(
  sessionId: string,
  request: Request,
  fork: SessionRouteActions["fork"],
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid-request", "request body must be JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("invalid-request", "request body must be an object", 400);
  }
  try {
    return jsonResponse(await fork(sessionId, body as ForkSessionCommand), 201);
  } catch (error) {
    if (error instanceof SessionForkInvalidError) {
      return errorResponse("invalid-fork", error.message, 400);
    }
    if (error instanceof SessionForkNotFoundError) {
      return errorResponse("session-not-found", error.message, 404);
    }
    // 409, not 400: nothing about the request was wrong. The branch is taken, or the directory is
    // already somebody else's worktree, and the same request works once that is resolved.
    if (error instanceof WorktreeError) {
      return errorResponse("fork-conflict", error.message, 409);
    }
    // 502 rather than 500, for the reason the Bot launch route gives: the request was valid and
    // what failed is the thing this sidecar delegates to -- tmux, or the CLI it starts.
    console.error("Session fork failed", error);
    return errorResponse(
      "fork-failed",
      error instanceof Error ? error.message : String(error),
      502,
    );
  }
}

/**
 * What the two POST routes delegate to, injected so a test never has to replace a module.
 *
 * Module replacement is global for a whole `bun test` run, so a route test that stood in for the
 * composer answered the composer's OWN tests too -- and they passed for the wrong reason. Every
 * other seam in this sidecar is a parameter for exactly that reason; these two were the holdouts.
 */
export interface SessionRouteActions {
  rename: typeof renameClaudeSession;
  fork: typeof forkClaudeSession;
}

export function createSessionRoutes(
  resolveAgentSession?: AgentSessionDescriptorResolver,
  actions: SessionRouteActions = { rename: renameClaudeSession, fork: forkClaudeSession },
): RouteHandler {
  return (request, url) => {
    if (request.method === "POST") {
      const titleMatch = TITLE_ROUTE.exec(url.pathname);
      const forkMatch = FORK_ROUTE.exec(url.pathname);
      if (!titleMatch && !forkMatch) return undefined;
      if (getWatcherState() !== "live") {
        // The panel's own envelope, unlike the GET paths below: these are read by dialogs that
        // show `error.message` and would otherwise say only "sidecar answered 503". The fork needs
        // it for a second reason -- it resolves its source through the catalog, so a catalog that
        // is still starting would answer "no such session" about one that is plainly there.
        return errorResponse("inventory-not-ready", "the session catalog is still starting", 503);
      }
      if (titleMatch) return renameSession(titleMatch[1]!.toLowerCase(), request, actions.rename);
      return forkSession(forkMatch![1]!.toLowerCase(), request, actions.fork);
    }
    if (request.method !== "GET") return undefined;
    if (getWatcherState() !== "live") {
      return jsonResponse({ error: "inventory-not-ready" }, 503);
    }
    if (url.pathname === "/api/sessions") {
      return sessionSnapshotResponse(url, resolveAgentSession);
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

    const lastMessageMatch = LAST_MESSAGE_ROUTE.exec(url.pathname);
    if (lastMessageMatch) return lastMessageResponse(lastMessageMatch[1]!.toLowerCase());

    const compactionMatch = LAST_COMPACTION_ROUTE.exec(url.pathname);
    if (compactionMatch) return lastCompactionResponse(compactionMatch[1]!.toLowerCase());

    const rawMatch = RAW_EVENT_ROUTE.exec(url.pathname);
    if (rawMatch) {
      if (mode === null) return jsonResponse({ error: "invalid mode" }, 400);
      return rawEvent(sourceId(rawMatch[1]!), rawMatch[2]!, Number(rawMatch[3]!), mode);
    }

    if (url.pathname.startsWith("/api/sessions/")) {
      return jsonResponse({ error: "invalid source or sessionId" }, 400);
    }
    return undefined;
  };
}

export const handleSessionRoutes = createSessionRoutes();
