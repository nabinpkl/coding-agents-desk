// A Bot's session references, resolved for what the panel will draw, and the ones that could not
// be. Said out loud, once per transition.
//
// The panel renders the literal word "missing" for every reference in `missingSessionRefs`
// (`BotCanvasCard.tsx`, `BotRosterRow.tsx`), and until this existed the only record of WHY a
// reference got there was the shape of the symptom: a row that said missing, and then a second
// later did not. Two unrelated things put a reference in that list and they look identical from
// the panel.
//
// One is that the catalog does not hold the session at all, and a restart is what that looks like
// from here. The bots stream is registered at `server.ts:308` and `startCatalog()` is called at
// `:314`, so for the whole of startup the stream answers while the catalog holds zero sessions,
// and every reference on every Bot resolves to nothing. Measured 2026-09-26 on this machine: that
// window is 416ms at the median, 550ms at p90, 1.6s at the worst, and the sidecar restarted 32
// times in the hour -- in bursts 1.4s apart, one restart per save into its own import graph.
//
// The other is that the catalog holds the session in a directory the Bot does not contain, which
// is a path comparison (`directoryBelongsTo`) and has nothing to do with the session being
// unreadable. A worktree probe inside that comparison returns null on any error at all, and null
// is read as "not yours", so one bad `realpath` is enough.
//
// So every line carries the discriminator -- the catalog's size, whether the catalog has finished
// starting, and both sides of the path comparison -- and the log is EDGE-triggered rather than
// level-triggered. This runs on every catalog broadcast, which is every coalesced transcript
// write, so a reference that is legitimately gone would otherwise write a line every time.
// Instead: one line when a reference ENTERS the list, one when it LEAVES, one if the reason
// changes while it stays. That pair is the chain -- what the registry decided, why, and for how
// long -- and the duration is the part that tells a flash from a fault.

import type { BotRecord, BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import { directoryBelongsTo, worktreeOf } from "@/git/worktree";
import { sessionKey } from "@/bots/botIdempotency";
import type { ResolvedBotSession } from "@/bots/botTypes";
import { state } from "@/transcripts/transcriptState";
import { getWatcherState } from "@/transcripts/catalog/catalogState";

/** Which of the two ways a reference failed to resolve. */
export type BotSessionMissingReason = "catalog-unresolved" | "outside-bot-directory";

/** What is held while a reference is missing, so the way out can say how long it took. */
interface MissingEntry {
  reason: BotSessionMissingReason;
  /** `Date.now()` at the moment this reference was first seen missing. */
  since: number;
  botId: string;
  bot: string;
  ref: BotSessionRef;
}

const missing = new Map<string, MissingEntry>();

/**
 * Forgets every remembered miss.
 *
 * For tests, which build and tear down registries in one run and would otherwise see each other's
 * references. The same shape as `forgetWorktrees`, and for the same reason: the remembered thing is
 * process-lifetime state whose only purpose is to make a log line edge-triggered.
 */
export function forgetMissingBotSessions(): void {
  missing.clear();
}

/** The two lists a Bot view is made of, and nothing else. */
export interface BotSessionSplit {
  sessions: SessionSummary[];
  missingSessionRefs: BotSessionRef[];
  /** What became of every reference, for the log to diff. See `noteBotSessionOutcomes`. */
  outcomes: BotSessionOutcome[];
}

/** One reference, and what this pass made of it. Carries what a log line needs, so it needs no lookup. */
export interface BotSessionOutcome {
  key: string;
  botId: string;
  bot: string;
  botPath: string;
  ref: BotSessionRef;
  missing: boolean;
  reason?: BotSessionMissingReason;
  /** Null when the catalog had nothing; the other side of the comparison when it had something. */
  sessionProjectPath?: string | null;
}

/**
 * Splits a Bot's references into the ones that resolved and the ones that did not.
 *
 * Says nothing itself. The log is diffed over a WHOLE snapshot rather than per Bot, because the
 * held set is process-global: a per-Bot diff would read every other Bot's still-missing reference
 * as resolved, once per Bot, on every broadcast. Collecting first and noting once is the only
 * ordering where "still missing" means what it says.
 *
 * `resolve` is the catalog's own lookup rather than a direct read of its state, so the registry
 * keeps its seam and a test can hand this a map. The comparison is deliberately the same predicate
 * the attach used, for the reason `botRegistry.ts` gives: a Bot that accepts a session and then
 * reports it missing is worse than one that refused it, because the refusal at least lands at the
 * moment somebody can act on it.
 */
export async function resolveBotSessions(
  record: BotRecord,
  resolve: (ref: BotSessionRef) => ResolvedBotSession | undefined,
): Promise<BotSessionSplit> {
  const sessions: SessionSummary[] = [];
  const missingSessionRefs: BotSessionRef[] = [];
  const outcomes: BotSessionOutcome[] = [];

  for (const ref of record.sessionRefs) {
    const resolved = resolve(ref);
    const inside = resolved
      ? await directoryBelongsTo(resolved.projectPath, record.environment.path)
      : false;
    const key = `${record.botId}|${sessionKey(ref)}`;
    if (resolved && inside) {
      sessions.push(
        await withWorktree(resolved.summary, resolved.projectPath, record.environment.path),
      );
      outcomes.push({
        key, botId: record.botId, bot: record.name, botPath: record.environment.path, ref, missing: false,
      });
      continue;
    }
    missingSessionRefs.push(ref);
    outcomes.push({
      key,
      botId: record.botId,
      bot: record.name,
      botPath: record.environment.path,
      ref,
      missing: true,
      reason: resolved ? "outside-bot-directory" : "catalog-unresolved",
      sessionProjectPath: resolved?.projectPath ?? null,
    });
  }

  return { sessions, missingSessionRefs, outcomes };
}

/**
 * The log, for one whole snapshot: one line per reference that has started being missing, and one
 * per reference that has stopped.
 *
 * Called once per view rather than once per Bot, and that is the whole reason the outcomes are
 * collected first. A reference that is still missing is one whose key is in this pass's outcomes at
 * all, so a reference on a Bot that was not part of the snapshot is not mistaken for one that
 * stopped being missing.
 */
export function noteBotSessionOutcomes(outcomes: BotSessionOutcome[]): void {
  const stillMissing = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.missing) continue;
    stillMissing.add(outcome.key);
    noteMissing(outcome);
  }
  noteResolved(stillMissing);
}

/**
 * Says which worktree a session is working in, when it is not the Bot's own directory.
 *
 * Only for the rows that need it. A Bot's sessions are usually all in its directory, and a field
 * that is present and empty on every one of those is a field every reader has to learn to
 * ignore. Absent means the ordinary case: this session is in the checkout the Bot names.
 *
 * The branch rather than the path, because the path is what a reader already sees on the Bot and
 * the branch is what they do not. Two sessions on one repository editing two branches look
 * identical without it, which is the failure that made accepting them worth guarding.
 */
async function withWorktree(
  summary: SessionSummary,
  projectPath: string,
  botPath: string,
): Promise<SessionSummary> {
  if (projectPath === botPath) return summary;
  const worktree = await worktreeOf(projectPath);
  if (!worktree) return summary;
  return { ...summary, worktree: { path: projectPath, branch: worktree.branch } };
}

/**
 * One line for a reference that is missing now, whether it has just started being missing or has
 * only changed its mind about why.
 *
 * The silent case is the common one and is the reason this is edge-triggered: a reference that was
 * missing on the previous pass and is missing now, for the same reason, says nothing, because the
 * line that announced it is still the current truth.
 */
function noteMissing(outcome: BotSessionOutcome): void {
  const reason = outcome.reason;
  if (!reason) return;
  const held = missing.get(outcome.key);
  const now = Date.now();
  if (held) {
    if (held.reason === reason) return;
    // The same reference, still missing, for a different reason: the catalog found the session and
    // then the path comparison disagreed, which is two different bugs reading as one without this.
    held.reason = reason;
    held.since = now;
  } else {
    missing.set(outcome.key, {
      reason, since: now, botId: outcome.botId, bot: outcome.bot, ref: outcome.ref,
    });
  }
  console.log(JSON.stringify({
    event: "agent-feed-bot-session-missing",
    botId: outcome.botId,
    bot: outcome.bot,
    reason,
    source: outcome.ref.source,
    sessionId: outcome.ref.sessionId,
    botPath: outcome.botPath,
    // The other side of the comparison, and the whole reason this line exists: null says the
    // catalog never had the session, a path says it had it somewhere the Bot does not reach.
    sessionProjectPath: outcome.sessionProjectPath ?? null,
    // Zero of these is the restart window, and it is the one field that says so without inference.
    catalogSessions: state.sessions.size,
    catalogState: getWatcherState(),
  }));
}

/**
 * One line per reference that stopped being missing, carrying how long it was.
 *
 * The duration is the part worth having. A flash is a few hundred milliseconds and lines up with a
 * `agent-feed-catalog-ready` in the same log; a fault is seconds or minutes and does not.
 */
function noteResolved(stillMissing: Set<string>): void {
  if (missing.size === 0) return;
  const now = Date.now();
  for (const [key, entry] of [...missing]) {
    if (stillMissing.has(key)) continue;
    missing.delete(key);
    console.log(JSON.stringify({
      event: "agent-feed-bot-session-resolved",
      botId: entry.botId,
      bot: entry.bot,
      reason: entry.reason,
      source: entry.ref.source,
      sessionId: entry.ref.sessionId,
      missingForMs: now - entry.since,
      catalogSessions: state.sessions.size,
      catalogState: getWatcherState(),
    }));
  }
}
