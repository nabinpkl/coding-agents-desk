// Archiving a session, and taking it back out.
//
// Archive is refused while the session is running, so archived always means "nobody is working
// in this": hiding a session an agent is still writing would leave work going on where no surface
// shows it. Unarchive is never refused. Both are POSTs because the host relay admits GET and POST
// only, the same reason the rename and Bot detach endpoints are.
//
// Under `/api/sessions/` and so ahead of the session routes' catch-all in `server.ts`.

import type { BotSessionRef, SourceId } from "@agentdesk/agent-feed-wire";
import {
  findSession,
  getWatcherState,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/transcriptCatalog";
import { currentProcessTable } from "@/tasks/processTable";
import { sessionOwner } from "@/tasks/sessionRegistry";
import { broadcast } from "@/transcripts/catalog/catalogState";
import type { Session } from "@/transcripts/transcriptTypes";
import type { SessionArchiveStore } from "@/transcripts/session-ops/sessionArchive";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const ARCHIVE_ROUTE = /^\/api\/sessions\/(claude|codex|pi|opencode)\/([0-9A-Za-z._:-]{1,128})\/(archive|unarchive)$/i;

export interface SessionArchiveRouteDependencies {
  archive: Pick<SessionArchiveStore, "archive" | "unarchive">;
  /** Whether a process is working in this session right now. */
  isRunning: (session: Session) => Promise<boolean>;
  /** Tells every inventory and Bot stream to republish. The catalog's own broadcast by default. */
  announce?: () => void;
  find?: (source: SourceId, sessionId: string) => Session | undefined;
  /** Whether the catalog has finished starting; until it has, "no such session" is not an answer. */
  catalogReady?: () => boolean;
}

/**
 * The running check the sidecar uses.
 *
 * Claude by its registry, which names the live process serving a session and checks the pid
 * against its start time (`tasks/sessionRegistry.ts`). Not by a stamped tmux pane: the pane
 * outlives the agent and drops back to a shell, and a session whose agent exited is exactly the
 * one a reader wants to archive. Every other source by its backend's word, which is what already
 * decides the row's live bin.
 */
export function liveSessionCheck(resolveAgentSession?: AgentSessionDescriptorResolver): (session: Session) => Promise<boolean> {
  return async (session) => {
    if (session.source === "claude") {
      return (await sessionOwner(session.sessionId, await currentProcessTable())) !== null;
    }
    return resolveAgentSession?.(session.source, session.sessionId)?.activity === "live";
  };
}

export function createSessionArchiveRoutes(dependencies: SessionArchiveRouteDependencies): RouteHandler {
  const announce = dependencies.announce ?? broadcast;
  const find = dependencies.find ?? findSession;
  const catalogReady = dependencies.catalogReady ?? (() => getWatcherState() === "live");
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    const match = ARCHIVE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const ref: BotSessionRef = { source: match[1]!.toLowerCase() as SourceId, sessionId: match[2]! };
    return match[3]!.toLowerCase() === "unarchive" ? unarchive(ref) : archive(ref);
  };

  async function unarchive(ref: BotSessionRef): Promise<Response> {
    if (await dependencies.archive.unarchive(ref)) announce();
    return jsonResponse({ ...ref, archived: false });
  }

  async function archive(ref: BotSessionRef): Promise<Response> {
    if (!catalogReady()) {
      return errorResponse("inventory-not-ready", "the session catalog is still starting", 503);
    }
    const session = find(ref.source, ref.sessionId) ?? find(ref.source, ref.sessionId.toLowerCase());
    if (!session) {
      return errorResponse("session-not-found", `no ${ref.source} session ${ref.sessionId}`, 404);
    }
    let running: boolean;
    try {
      running = await dependencies.isRunning(session);
    } catch (error) {
      console.error("Session archive could not tell whether the session is running", error);
      return errorResponse(
        "archive-unavailable",
        "could not tell whether the session is still running, so it was not archived",
        503,
      );
    }
    // 409, not 400: nothing about the request was wrong, and the same request works once the
    // session has stopped.
    if (running) {
      return errorResponse("session-running", "this session is still running; stop it before archiving it", 409);
    }
    const archivedAt = await dependencies.archive.archive({ source: session.source, sessionId: session.sessionId });
    announce();
    return jsonResponse({ source: session.source, sessionId: session.sessionId, archived: true, archivedAt });
  }
}
