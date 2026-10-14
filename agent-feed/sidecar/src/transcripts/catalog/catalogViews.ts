// What a reader is handed: the project list, one session's summary, and the activity bin
// each of them wears.
//
// A fold over what the catalog holds, and nothing else -- no disk, no watchers. The
// project list is memoized on the catalog generation because it is the one projection
// that N subscribers would otherwise each recompute on every change.

import { sessionArchivedAt } from "@/transcripts/session-ops/sessionArchive";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { basename, relative } from "node:path";
import type {
  AgentSessionCapabilities,
  AgentSessionDescriptor,
} from "@/agents/agentBackend";
import { PI_AGENT_CAPABILITIES } from "@/agents/piAgentBackend";
import { OPENCODE_AGENT_CAPABILITIES } from "@/agents/opencode/opencodeAgentBackend";
import { state } from "@/transcripts/transcriptState";
import { compactTitle } from "@/transcripts/catalog/catalogRecords";
import type { Bin, Session, SourceId } from "@/transcripts/transcriptTypes";
import {
  memoizedProjectSummaries,
  rememberProjectSummaries,
  sessionKey,
  SUMMARY_TITLE_CHARACTERS,
  TRANSCRIPT_CAPABILITIES,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/catalogState";
import { getSnapshot } from "@/transcripts/catalog/catalogState";

/**
 * The project list for the current catalog.
 *
 * Memoized on the generation, so N subscribers watching the same catalog compute it
 * once between changes rather than once each, every change.
 */
export function projectSummaries(sessions?: Session[]): ProjectSummary[] {
  // An explicitly supplied snapshot is somebody else's view of the world and is not
  // what this generation's memo describes, so it is computed and not stored.
  if (sessions) return computeProjectSummaries(sessions);
  const memo = memoizedProjectSummaries();
  if (memo) return memo;
  const value = computeProjectSummaries(getSnapshot());
  rememberProjectSummaries(value);
  return value;
}

/**
 * Says so when deriving a view took long enough to mean something changed.
 *
 * Both derivations below are folds over records already in memory: the project list
 * is 0.3 ms over 1237 sessions, a project's session list 1-2 ms over 305. They used
 * to read transcripts and take seconds, which is why each one traced its own duration
 * on every emission -- a number worth having when it was 7000. At single-digit
 * milliseconds that same line fires up to 25 times a second per open project to
 * report that nothing happened, which is how a log stops being read.
 *
 * So it reports the overrun instead of the duration. That keeps the one thing the
 * trace was still good for, because the way a transcript body read gets back into
 * this path is quietly, and 50 ms is roughly 25x the honest cost and 140x under what
 * a single body read used to be.
 */
const VIEW_DERIVATION_BUDGET_MS = 50;

function reportSlowDerivation(
  event: string,
  startedAt: number,
  detail: Record<string, unknown>,
): void {
  const durationMs = performance.now() - startedAt;
  if (durationMs < VIEW_DERIVATION_BUDGET_MS) return;
  console.warn(JSON.stringify({
    event,
    durationMs: Math.round(durationMs * 100) / 100,
    budgetMs: VIEW_DERIVATION_BUDGET_MS,
    subscribers: state.subscribers.size,
    ...detail,
  }));
}

function computeProjectSummaries(sessions: Session[]): ProjectSummary[] {
  const startedAt = performance.now();
  const grouped = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    let project = grouped.get(session.project);
    if (!project) {
      project = {
        projectPath: session.project,
        displayName: basename(session.project),
        sourceCounts: { claude: 0, codex: 0, opencode: 0 },
        sessionCount: 0,
        lastEventAt: 0,
      };
      grouped.set(session.project, project);
    }
    project.sourceCounts[session.source] = (project.sourceCounts[session.source] ?? 0) + 1;
    project.sessionCount += 1;
    project.lastEventAt = Math.max(project.lastEventAt, session.lastEventAt);
  }
  const projects = [...grouped.values()].sort((left, right) =>
    right.lastEventAt - left.lastEventAt || left.projectPath.localeCompare(right.projectPath)
  );
  reportSlowDerivation("agent-feed-project-snapshot-slow", startedAt, {
    projects: projects.length,
  });
  return projects;
}

function computeActivity(lastEventAt: number, lastTurnClosed: boolean): Bin {
  const age = Date.now() - lastEventAt;
  if (!lastTurnClosed && age < config.liveWindowMs) return "live";
  if (age < config.readyThresholdMs) return "ready";
  if (age < config.staleThresholdMs) return "paused";
  return "cold";
}

/**
 * What a session can do, resolved the one way.
 *
 * A transcript session is read-only unless a live mirror answers for it, in which
 * case it also streams; a Pi session takes its backend's word and falls back to the
 * static Pi table. Exported because the timeline endpoint decides which streams to
 * open from exactly these flags, and a second copy of this rule would be free to
 * disagree with what the session list published.
 */
export function sessionCapabilities(
  source: SourceId,
  sessionId: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): AgentSessionCapabilities {
  const descriptor = resolveAgentSession?.(source, sessionId);
  if (source === "pi") return descriptor?.capabilities ?? PI_AGENT_CAPABILITIES;
  if (source === "opencode") return descriptor?.capabilities ?? OPENCODE_AGENT_CAPABILITIES;
  return descriptor?.capabilities.canStreamLive
    ? { ...TRANSCRIPT_CAPABILITIES, canStreamLive: true }
    : TRANSCRIPT_CAPABILITIES;
}

/**
 * One session's row, from the record the catalog already holds.
 *
 * Nothing here touches the disk. That is the whole point: this used to walk the
 * transcript body -- every line of it, `JSON.parse` per line -- to recover a title
 * and a turn state, so asking for a project's three most recent rows read all 305 of
 * its transcripts end to end and took seven seconds. Both of those facts now ride the
 * session record, put there by the bounded metadata read that discovered the session,
 * so listing is a projection rather than a scan.
 *
 * Title precedence: whatever the source calls the session, then its opening prompt,
 * then its id. The prompt fallback exists because a titleless session would otherwise
 * render as a UUID; the id is the last resort and its appearance in the list is the
 * standing signal that a source stopped answering.
 */
export function summarizeSession(
  session: Session,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): SessionSummary {
  // Every source resolves a descriptor the same way: a live backend answering for a
  // catalog session is what makes it live, whichever store the session came from.
  const live = resolveAgentSession?.(session.source, session.sessionId);
  // `lastEventAt` is the catalog's, not re-derived here. Both transcript sources stamp
  // it from the file itself during reconciliation, so a second reading taken at
  // emission time could only disagree with the one every other consumer is using.
  const lastEventAt = session.lastEventAt;
  const archivedAt = sessionArchivedAt(session.source, session.sessionId);
  return {
    sessionId: session.sessionId,
    source: session.source,
    // Trimmed here and not only where the record was built, because not every record
    // is built here: a Pi session registered by its backend arrives with whatever
    // title that backend chose, and a row is not the place to find that out.
    title: compactTitle(session.title) ?? compactTitle(session.firstPrompt) ??
      session.sessionId,
    lastEventAt,
    activity: summaryActivity(session, live),
    capabilities: sessionCapabilities(
      session.source,
      session.sessionId,
      resolveAgentSession,
    ),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

/** Which bin a row lands in, given what the catalog knows and who is answering for it. */
function summaryActivity(
  session: Session,
  live: AgentSessionDescriptor | undefined,
): Bin {
  // Pi and opencode take their backend's word outright, including a non-live
  // answer: the backend is the session's owner, not an observer of it.
  if (session.source === "pi" || session.source === "opencode") {
    return live?.activity ?? computeActivity(session.lastEventAt, true);
  }
  // For the transcript sources a live backend can only promote a row, never demote
  // one, because a backend that has not heard of a session says nothing about it
  // rather than saying it is idle.
  if (live?.activity === "live") return "live";
  // A source that could not answer cheaply left the turn state unset, which reads as
  // closed: a session is not shown live on the strength of a missing fact.
  return computeActivity(session.lastEventAt, session.lastTurnClosed ?? true);
}

/**
 * One project's session list, sorted the way it is rendered.
 *
 * Takes the snapshot when the caller already has one -- the inventory stream is
 * handed a snapshot per broadcast, and `getSnapshot()` sorts every session in the
 * catalog to produce it, which is not work worth repeating per open project.
 */
export function sessionSummaries(
  projectPath: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
  snapshot?: Session[],
): SessionSummary[] {
  const startedAt = performance.now();
  const summaries = (snapshot ?? getSnapshot())
    .filter((session) => session.project === projectPath)
    .map((session) => summarizeSession(session, resolveAgentSession));
  summaries.sort((left, right) =>
    right.lastEventAt - left.lastEventAt ||
    left.source.localeCompare(right.source) ||
    left.sessionId.localeCompare(right.sessionId)
  );
  reportSlowDerivation("agent-feed-session-snapshot-slow", startedAt, {
    projectPath,
    sessions: summaries.length,
  });
  return summaries;
}

/**
 * The `limit` most recently changed unarchived sessions across every project, and whether more
 * stand behind them.
 *
 * Cheap because the order is already paid for: every catalog snapshot is sorted by `lastEventAt`
 * before a subscriber sees it, so this walks the front of it and stops. Records, not summaries --
 * the stream compares the cut before deciding whether to summarize it at all.
 */
export function mostRecentSessions(
  snapshot: Session[],
  limit: number,
): { sessions: Session[]; more: boolean } {
  const sessions: Session[] = [];
  for (const session of snapshot) {
    if (sessionArchivedAt(session.source, session.sessionId) !== undefined) continue;
    if (sessions.length === limit) return { sessions, more: true };
    sessions.push(session);
  }
  return { sessions, more: false };
}
