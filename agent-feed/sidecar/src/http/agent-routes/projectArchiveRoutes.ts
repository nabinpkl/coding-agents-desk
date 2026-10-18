// Archiving a whole project folder, and archiving every session in one.
//
// Two different things on purpose. Archiving the folder files the folder itself: the project
// leaves the list and every session in it reads as archived, including one started there later.
// Archiving its sessions files each stopped session one by one, in one write, and leaves the folder
// listed, so a session started there tomorrow shows up as usual.
//
// Both keep the session rule that archived means nobody is working in it: the folder is refused
// while any session in it is running, and the bulk archive leaves running sessions where they are
// and says how many it left. POSTs with the path in the body, because a project path is a file path
// and the host relay admits GET and POST only.

import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { broadcast, getSnapshot, getWatcherState } from "@/transcripts/catalog/catalogState";
import type { Session } from "@/transcripts/transcriptTypes";
import type { SessionArchiveStore } from "@/transcripts/session-ops/sessionArchive";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const PROJECT_ARCHIVE_ROUTE = /^\/api\/projects\/(archive|unarchive|archive-sessions)$/;

export interface ProjectArchiveRouteDependencies {
  archive: Pick<SessionArchiveStore, "archiveMany" | "archiveProject" | "unarchiveProject">;
  /** Whether a process is working in this session right now. */
  isRunning: (session: Session) => Promise<boolean>;
  /** Tells every inventory and Bot stream to republish. The catalog's own broadcast by default. */
  announce?: () => void;
  /** Every session the catalog lists under this project. */
  sessionsIn?: (projectPath: string) => Session[];
  /** Whether the catalog has finished starting; until it has, "no such project" is not an answer. */
  catalogReady?: () => boolean;
}

export function createProjectArchiveRoutes(dependencies: ProjectArchiveRouteDependencies): RouteHandler {
  const announce = dependencies.announce ?? broadcast;
  const sessionsIn = dependencies.sessionsIn
    ?? ((projectPath: string) => getSnapshot().filter((session) => session.project === projectPath));
  const catalogReady = dependencies.catalogReady ?? (() => getWatcherState() === "live");
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    const match = PROJECT_ARCHIVE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    return handle(match[1] as "archive" | "unarchive" | "archive-sessions", request);
  };

  async function handle(action: "archive" | "unarchive" | "archive-sessions", request: Request): Promise<Response> {
    let projectPath: unknown;
    try {
      projectPath = ((await request.json()) as { projectPath?: unknown } | null)?.projectPath;
    } catch {
      return errorResponse("invalid-request", "the body must be JSON naming a projectPath", 400);
    }
    if (typeof projectPath !== "string" || projectPath.length === 0) {
      return errorResponse("invalid-request", "projectPath must be a non-empty string", 400);
    }
    if (action === "unarchive") {
      if (await dependencies.archive.unarchiveProject(projectPath)) announce();
      return jsonResponse({ projectPath, archived: false });
    }
    if (!catalogReady()) {
      return errorResponse("inventory-not-ready", "the session catalog is still starting", 503);
    }
    const sessions = sessionsIn(projectPath);
    if (sessions.length === 0) {
      return errorResponse("project-not-found", `no sessions are listed under ${projectPath}`, 404);
    }
    let running: Session[];
    try {
      running = await runningSessions(sessions);
    } catch (error) {
      console.error("Project archive could not tell which sessions are running", error);
      return errorResponse(
        "archive-unavailable",
        "could not tell which sessions are still running, so nothing was archived",
        503,
      );
    }
    return action === "archive" ? archiveFolder(projectPath, running) : archiveSessions(projectPath, sessions, running);
  }

  async function archiveFolder(projectPath: string, running: Session[]): Promise<Response> {
    // 409, not 400: nothing about the request was wrong, and it works once those sessions stop.
    if (running.length > 0) {
      return errorResponse(
        "session-running",
        `${running.length} ${running.length === 1 ? "session is" : "sessions are"} still running in this folder; stop ${
          running.length === 1 ? "it" : "them"
        } before archiving the folder`,
        409,
      );
    }
    const archivedAt = await dependencies.archive.archiveProject(projectPath);
    announce();
    return jsonResponse({ projectPath, archived: true, archivedAt });
  }

  async function archiveSessions(projectPath: string, sessions: Session[], running: Session[]): Promise<Response> {
    const busy = new Set(running);
    const refs: BotSessionRef[] = sessions
      .filter((session) => !busy.has(session))
      .map((session) => ({ source: session.source, sessionId: session.sessionId }));
    const archived = refs.length === 0 ? 0 : await dependencies.archive.archiveMany(refs);
    if (archived > 0) announce();
    return jsonResponse({ projectPath, archived, running: running.length });
  }

  async function runningSessions(sessions: Session[]): Promise<Session[]> {
    const checks = await Promise.all(sessions.map(async (session) => [session, await dependencies.isRunning(session)] as const));
    return checks.filter(([, running]) => running).map(([session]) => session);
  }
}
