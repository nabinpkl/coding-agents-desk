import {
  eventsOf,
  NotALineStartError,
  parsedLinesBetween,
  readEventRaw,
  readPageAfter,
  readPageAround,
  readPageBefore,
  readSessionMeter,
  type ParsedTranscriptLine,
  type SessionMeter,
} from "@/transcripts/transcript-reads/transcriptPages";
import { LineTooLargeError } from "@/transcripts/transcript-reads/transcriptLines";
import { followTranscript, type FollowHandle } from "@/transcripts/transcript-reads/transcriptFollow";
import {
  canonicalProjectPath,
  findSession,
  getSnapshot,
  getWatcherState,
  sessionSummaries,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/transcriptCatalog";
import type {
  ActivityEvent,
  EventMode,
  TranscriptSourceId,
} from "@/transcripts/transcriptTypes";
import {
  eventsPageAtFromQuery,
  type EventsPage,
  type EventsPageAt,
  type ForkSessionCommand,
  type TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";
import { createTimelineFollower } from "@/http/session-routes/timelineCheckpoint";
import {
  renameClaudeSession,
  SessionRenameInvalidError,
  SessionRenameNotFoundError,
  SessionRenameUnavailableError,
} from "@/transcripts/session-ops/renameSession";
import {
  forkClaudeSession,
  SessionForkInvalidError,
  SessionForkNotFoundError,
} from "@/transcripts/session-ops/forkSession";
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
 * `at` says where it is read from; the newest page is `{ before: null }`. Exported because the
 * composite timeline endpoint opens on the same read and the summarizer walks back through it:
 * two ways to page one transcript is exactly the drift this module exists to prevent.
 */
export async function readTranscriptPage(
  source: TranscriptSourceId,
  sessionId: string,
  at: EventsPageAt,
  limit: number,
  mode: EventMode,
): Promise<EventsPage | null> {
  const session = findSession(source, sessionId);
  if (!session || !session.transcriptPath) return null;
  const path = session.transcriptPath;
  const page = "after" in at
    ? await readPageAfter(source, sessionId, path, at.after, limit, mode)
    : "around" in at
      ? await readPageAround(source, sessionId, path, at.around, limit, mode)
      : await readPageBefore(source, sessionId, path, at.before, limit, mode);
  // The meter is the session's, not the page's, so only the newest page reads it: any other page
  // is scrollback, and the end of the file is a read of its own.
  const meter = "before" in at && at.before === null
    ? await readSessionMeter(source, path, page.end)
    : null;
  return {
    events: page.events,
    windowStart: page.windowStart,
    mode,
    usage: meter?.usage ?? null,
    sequence: page.end,
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
  };
}

async function paginatedEvents(
  source: TranscriptSourceId,
  sessionId: string,
  at: EventsPageAt,
  limit: number,
  mode: EventMode,
): Promise<Response> {
  try {
    const page = await readTranscriptPage(source, sessionId, at, limit, mode);
    if (!page) return jsonResponse({ error: "session not found" }, 404);
    return jsonResponse(page);
  } catch (error) {
    if (error instanceof NotALineStartError) return jsonResponse({ error: error.message }, 400);
    throw error;
  }
}

async function rawEvent(
  source: TranscriptSourceId,
  sessionId: string,
  position: number,
): Promise<Response> {
  const session = findSession(source, sessionId);
  if (!session || !session.transcriptPath) return jsonResponse({ error: "session not found" }, 404);
  try {
    const raw = await readEventRaw(session.transcriptPath, position);
    if (raw === null) return jsonResponse({ error: "event not found" }, 404);
    return new Response(raw, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof LineTooLargeError) {
      return jsonResponse({ error: error.message, byteCount: error.byteCount }, 413);
    }
    throw error;
  }
}

/**
 * Follows one transcript-backed session from `after`, the end of the page its reader opened on,
 * streaming rows as the file grows. Returns the teardown, or null when no such session is known.
 *
 * Transport-free -- it hands envelopes to a callback rather than writing SSE -- so the composite
 * `/timeline` endpoint and anything else that follows a transcript share one rule about where a
 * follow starts and which rows a reader has already been given.
 *
 * What it hands over is decided by `createTimelineFollower`, not here: rows while this reader is
 * keeping up, and a checkpoint when it is not. A fork writes its whole resumed conversation in one
 * flush, and a reader who opened before it is a window behind the moment it lands.
 */
export function subscribeTranscriptTimeline(
  source: TranscriptSourceId,
  sessionId: string,
  after: number,
  meter: SessionMeter,
  mode: EventMode,
  handlers: {
    onEnvelope: (envelope: TimelineEnvelope) => void;
    onError: (message: string) => void;
  },
  /** The newest row of the opening page, which is what the first row after it follows. */
  previous: number | null,
): (() => void) | null {
  const session = findSession(source, sessionId);
  if (!session || !session.transcriptPath) return null;
  const transcriptPath = session.transcriptPath;
  let cancelled = false;
  const fail = (error: unknown): void => {
    handlers.onError(error instanceof Error ? error.message : String(error));
  };
  let follow: FollowHandle | null = null;
  const follower = createTimelineFollower({
    mode,
    // A transcript is only ever appended to, so a position means the same line before and after a
    // checkpoint and a reader keeps whatever they had paged in below it.
    stableIndices: true,
    // Occupancy rides every envelope, read per write rather than captured so it is never stale.
    usage: () => follow?.usage() ?? meter.usage,
    emit: handlers.onEnvelope,
  });
  // Rows are delivered strictly in file order, each once, starting after the opening page. The
  // follow hands lines over in order; the catch-up read below and the follow can both hold the
  // same line at the seam, so anything at or before the newest delivered position is dropped.
  let delivered = after - 1;
  let last = previous;
  let lastText: ActivityEvent | null = null;
  let ready = false;
  const held: ParsedTranscriptLine[] = [];
  const deliver = (line: ParsedTranscriptLine): void => {
    if (line.position <= delivered) return;
    delivered = line.position;
    const content = line.result.lineClass !== "machinery";
    if (!content && line.result.cacheHit && lastText) {
      // A Codex `token_count` reports the cache for a turn whose prose row was already sent. The
      // row is re-sent with the badge and a newer revision, which is what the panel's upsert keeps.
      lastText = { ...lastText, cacheHit: line.result.cacheHit, revision: lastText.revision + 1 };
      follower.offer(lastText);
    }
    const [event] = eventsOf(source, sessionId, [line], mode, last);
    if (!event) return;
    last = event.index;
    if (content && event.blocks.some((block) => block.kind === "text")) lastText = event;
    follower.offer(event);
  };
  follow = followTranscript(
    source,
    sessionId,
    transcriptPath,
    (line) => {
      if (cancelled) return;
      if (ready) deliver(line);
      else held.push(line);
    },
    fail,
  );
  const reading = follow;
  void (async () => {
    const from = reading.start(after, meter);
    // Another reader started this follow later than this one's page ended, so the lines between
    // were read before this reader was listening. Read them here; the seam is deduplicated above.
    if (from > after) {
      const missed = await parsedLinesBetween(source, transcriptPath, after, from);
      if (cancelled) return;
      for (const line of missed) deliver(line);
    }
    ready = true;
    for (const line of held.splice(0)) deliver(line);
  })().catch((error) => {
    if (!cancelled) fail(error);
  });
  return () => {
    cancelled = true;
    // Before the release, so a flush already queued for this microtask cannot write to a
    // subscriber that has left.
    follower.close();
    reading.release();
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
      // A position to read before, after or around, or none for the newest page. There is no
      // `offset`: nothing here counts rows from the top any more, which is what made the first
      // page cost the whole file.
      const at = eventsPageAtFromQuery(url.searchParams);
      const limit = integerQuery(url, "limit", 100, 500);
      if (at === null) return jsonResponse({ error: "invalid position" }, 400);
      if (limit === null || limit < 1) {
        return jsonResponse({ error: "invalid pagination" }, 400);
      }
      if (mode === null) return jsonResponse({ error: "invalid mode" }, 400);
      return paginatedEvents(sourceId(eventMatch[1]!), eventMatch[2]!, at, limit, mode);
    }

    const lastMessageMatch = LAST_MESSAGE_ROUTE.exec(url.pathname);
    if (lastMessageMatch) return lastMessageResponse(lastMessageMatch[1]!.toLowerCase(), url);

    const compactionMatch = LAST_COMPACTION_ROUTE.exec(url.pathname);
    if (compactionMatch) return lastCompactionResponse(compactionMatch[1]!.toLowerCase());

    const rawMatch = RAW_EVENT_ROUTE.exec(url.pathname);
    if (rawMatch) {
      return rawEvent(sourceId(rawMatch[1]!), rawMatch[2]!, Number(rawMatch[3]!));
    }

    if (url.pathname.startsWith("/api/sessions/")) {
      return jsonResponse({ error: "invalid source or sessionId" }, 400);
    }
    return undefined;
  };
}

export const handleSessionRoutes = createSessionRoutes();
