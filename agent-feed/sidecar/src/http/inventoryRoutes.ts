import {
  canonicalProjectPath,
  getSnapshot,
  getWatcherState,
  projectSummaries,
  sessionSummaries,
  subscribeCatalog,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/transcriptCatalog";
import { sessionArchivedAt } from "@/transcripts/session-ops/sessionArchive";
import type { Session } from "@/transcripts/transcriptTypes";
import {
  encodeServerSentEvent,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

/**
 * Which projects this surface has open, of the ones it asked for.
 *
 * A project that no longer canonicalizes is DROPPED rather than refused. Refusing
 * would deadlock the surface: the requested set is whatever the reader last had
 * expanded, and the only thing that would tell it a project is gone is the project
 * list riding this very stream. So a directory deleted while its row was open would
 * refuse the stream, the retry would ask for the same vanished path, and the sidebar
 * would never learn why. Dropping it is self-correcting -- the project list on the
 * next message no longer has it, the reader collapses the row, and the following
 * subscription asks for a set that exists.
 */
async function requestedProjects(url: URL): Promise<string[]> {
  // Repeated rather than comma-joined: a project path is a filesystem path, and a
  // separator inside a value is a parsing bug waiting for the first directory that
  // contains one.
  const requested = [...new Set(url.searchParams.getAll("projectPath"))];
  const resolved: string[] = [];
  for (const path of requested) {
    const canonical = await canonicalProjectPath(path);
    if (canonical === path) resolved.push(canonical);
    else console.warn(JSON.stringify({ event: "agent-feed-inventory-unknown-project", path }));
  }
  return resolved;
}

/**
 * What a project's session list depends on, flattened for comparison.
 *
 * The catalog broadcasts on any change to any source, so most ticks change nothing
 * this project's viewer would see. Comparing the inputs is what keeps a stream from
 * re-emitting an identical list on every tick -- and it is compared per project, so a
 * write in one project does not resend the others.
 *
 * Every field a row renders is here, which is the property that has to hold: a fact
 * the summary reads and this does not is a change the stream would silently swallow.
 * The one thing not captured is the clock, and it never was -- an activity bin decays
 * with age, so a row that ages out of `live` is republished by the next reconcile
 * rather than at the instant it expires.
 */
function sessionsFingerprint(
  sessions: Session[],
  projectPath: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): string {
  return JSON.stringify(
    sessions
      .filter((session) => session.project === projectPath)
      .map((session) => [
        session.source,
        session.sessionId,
        session.lastEventAt,
        session.title,
        session.firstPrompt,
        session.lastTurnClosed,
        resolveAgentSession?.(session.source, session.sessionId)?.activity,
        sessionArchivedAt(session.source, session.sessionId),
      ]),
  );
}

async function inventoryStream(
  request: Request,
  url: URL,
  server: Parameters<RouteHandler>[2],
  resolveAgentSession?: AgentSessionDescriptorResolver,
): Promise<Response> {
  const projectPaths = await requestedProjects(url);
  return startServerSentEventStream(request, server, (write) => {
    let projectsFingerprint: string | null = null;
    const sessionFingerprints = new Map<string, string>();

    const pushProjects = (sessions: Session[]): void => {
      const projects = projectSummaries(sessions);
      const fingerprint = JSON.stringify(projects);
      if (fingerprint === projectsFingerprint) return;
      projectsFingerprint = fingerprint;
      write(encodeServerSentEvent({ projects }));
    };

    const pushSessions = (sessions: Session[], projectPath: string): void => {
      const fingerprint = sessionsFingerprint(sessions, projectPath, resolveAgentSession);
      if (fingerprint === sessionFingerprints.get(projectPath)) return;
      sessionFingerprints.set(projectPath, fingerprint);
      write(encodeServerSentEvent({
        projectPath,
        // The snapshot this tick is about, rather than a fresh one: the fingerprint
        // above was computed from it, so anything else could publish a list the
        // comparison never saw.
        sessions: sessionSummaries(projectPath, resolveAgentSession, sessions),
      }));
    };

    const push = (sessions = getSnapshot()): void => {
      pushProjects(sessions);
      for (const projectPath of projectPaths) pushSessions(sessions, projectPath);
    };

    push();
    return subscribeCatalog(push);
  });
}

/**
 * The whole inventory a surface renders, on one stream.
 *
 * A panel with three projects expanded used to hold four connections: one for the
 * project list and one per project. Every one of them rode the same catalog
 * subscription and answered from the same snapshot, so the split bought nothing but
 * connections -- and connections are the scarce thing, because the relay between the
 * panel and this process admits a bounded number of them. Expanding a fourth project
 * exhausted that budget, and the refusal landed on whichever request asked next.
 *
 * One stream per surface instead, parameterized by which projects that surface has
 * open. The project list always rides it; each requested project's session list rides
 * it too, named by `projectPath` so the reader can tell the two message shapes apart.
 */
export function createInventoryRoutes(
  resolveAgentSession?: AgentSessionDescriptorResolver,
): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== "/api/inventory/stream") return undefined;
    if (getWatcherState() !== "live") {
      return jsonResponse({ error: "inventory-not-ready" }, 503);
    }
    return inventoryStream(request, url, server, resolveAgentSession);
  };
}
