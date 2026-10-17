// The arena's own record of a run, the registry that holds the live ones, and the projections
// that turn records into the wire's summaries and details.
//
// Records are the source of truth for everything the arena knows about a run; persistence is
// `arenaStore.ts` and driving the contestants is `arenaService.ts`. This module owns the shape
// and the change signal: every mutation a run's life makes goes through the registry, which
// tells its listeners once per change, and the routes stream exactly that signal.

import type { ContestantResume } from "@/arena/contestants/contestantDriver";
import {
  ARENA_LIVE_STATUSES,
  type ArenaContestantDetail,
  type ArenaContestantSource,
  type ArenaContestantStatus,
  type ArenaContestantSummary,
  type ArenaJudgeSummary,
  type ArenaOutsideReach,
  type ArenaRunDetail,
  type ArenaRunMode,
  type ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";

/** One contestant, as the arena tracks it. Facts are filled in as they are observed. */
export interface ArenaContestantRecord {
  contestantId: string;
  source: ArenaContestantSource;
  /** The session this contestant is, once its driver has one; null until then. */
  sessionId: string | null;
  worktreePath: string;
  /** The tmux session it runs in, terminals mode only; kept until the run is deleted. */
  tmuxSession: string | null;
  status: ArenaContestantStatus;
  startedAt: number | null;
  closedAt: number | null;
  error: string | null;
  contextTokens: number | null;
  costUsd: number | null;
  filesRead: string[];
  filesWritten: string[];
  /** Where outside its worktree its tools reached, read off its events at close. */
  outsideReached: ArenaOutsideReach[];
  /** In memory while the sidecar runs; on disk in the store once the contestant has closed. */
  gitDiff: string | null;
}

/** One run, as the arena tracks it. Contestants are ordered as the request named them. */
export interface ArenaRunRecord {
  runId: string;
  name: string;
  /** The run's folder in the arena home, holding its worktrees; removed with the run. */
  folder: string;
  /** The latest prompt; empty while a terminals run has its lanes open and waits for its first. */
  prompt: string;
  /** How many prompts the run has been given. */
  round: number;
  repoPath: string;
  /** The arena made `repoPath` as the run's folder, so it goes when the run does. */
  repoCreated: boolean;
  baseRef: string;
  mode: ArenaRunMode;
  createdAt: number;
  contestants: ArenaContestantRecord[];
  /** The run's judge, or null when it asked for none; its life is `judge/arenaJudges.ts`. */
  judge: ArenaJudgeRecord | null;
}

/** A judge, as the arena tracks it: the summary's own fields, since none of it is derived. */
export type ArenaJudgeRecord = ArenaJudgeSummary;

/** Whether a contestant is still live work rather than a settled fact. */
export function isLiveContestant(contestant: Pick<ArenaContestantRecord, "status">): boolean {
  return ARENA_LIVE_STATUSES.includes(contestant.status);
}

/** A contestant's summary, with its duration derived from the stamps it carries. */
export function contestantSummary(record: ArenaContestantRecord): ArenaContestantSummary {
  return {
    contestantId: record.contestantId,
    source: record.source,
    sessionId: record.sessionId,
    worktreePath: record.worktreePath,
    tmuxSession: record.tmuxSession,
    status: record.status,
    startedAt: record.startedAt,
    closedAt: record.closedAt,
    durationMs:
      record.startedAt !== null && record.closedAt !== null
        ? record.closedAt - record.startedAt
        : null,
    error: record.error,
  };
}

export function runSummary(run: ArenaRunRecord): ArenaRunSummary {
  return {
    runId: run.runId,
    name: run.name,
    folder: run.folder,
    prompt: run.prompt,
    round: run.round,
    repoPath: run.repoPath,
    repoCreated: run.repoCreated,
    baseRef: run.baseRef,
    mode: run.mode,
    createdAt: run.createdAt,
    contestants: run.contestants.map(contestantSummary),
    judge: run.judge ? { ...run.judge } : null,
  };
}

/**
 * The run with its facts, diffs included.
 *
 * `gitDiff` prefers the in-memory record, which is authoritative while the sidecar that drove
 * the run is the one answering, and falls back to the store for a run reloaded from disk --
 * which is the one case where the store has a diff the record does not.
 */
export function runDetail(run: ArenaRunRecord, storedDiff: (c: ArenaContestantRecord) => string | null): ArenaRunDetail {
  return {
    ...runSummary(run),
    contestants: run.contestants.map((record) => {
      const detail: ArenaContestantDetail = {
        ...contestantSummary(record),
        contextTokens: record.contextTokens,
        costUsd: record.costUsd,
        filesRead: [...record.filesRead],
        filesWritten: [...record.filesWritten],
        outsideReached: record.outsideReached.map((reach) => ({ ...reach })),
        gitDiff: record.gitDiff ?? storedDiff(record),
      };
      return detail;
    }),
  };
}

/** What a restart leaves of one unfinished contestant: driven again, or failed with why. */
export type RestartOutcome = { failed: string } | { drive: ContestantResume | null };

/**
 * What a restarted sidecar does with a contestant its predecessor was still driving.
 *
 * The drive lived in the old process; a terminals contestant's harness did not. Its pane is
 * tmux's and its session is named on the record, so it is picked back up from both: watched to
 * its turn's close if its run had already let it go with the prompt, or brought back to the start
 * line if not. One that had no pane yet is started over. A headless contestant was driven from
 * inside the old process itself, so nothing of it is left to pick up, and it fails saying so.
 * The failures are what keep a reloaded run from reading as a duel still going, forever.
 */
export function afterRestart(
  run: Pick<ArenaRunRecord, "mode">,
  contestant: Pick<ArenaContestantRecord, "status" | "tmuxSession" | "sessionId">,
  terminalsHere: boolean,
): RestartOutcome {
  if (run.mode === "headless") {
    return { failed: "the sidecar restarted mid-turn, and a headless contestant cannot be picked back up" };
  }
  if (!terminalsHere) return { failed: "the sidecar came back with no tmux, so its pane cannot be picked back up" };
  if (contestant.status === "preparing") return { drive: null };
  if (!contestant.tmuxSession || !contestant.sessionId) {
    return { failed: "the sidecar restarted before this contestant's pane was on its record" };
  }
  return {
    drive: {
      pane: contestant.tmuxSession,
      sessionId: contestant.sessionId,
      prompted: contestant.status === "running",
    },
  };
}

/**
 * The live runs, their change signal, and one controlled way to mutate them.
 *
 * Mutations go through `updateContestant` so a listener always sees a run after a whole
 * transition has landed, never halfway through one, and so persistence (which subscribes like
 * any other listener) cannot save a torn state.
 */
export class ArenaRunRegistry {
  private readonly runs = new Map<string, ArenaRunRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(options: { initial?: ArenaRunRecord[]; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    for (const run of options.initial ?? []) this.runs.set(run.runId, run);
  }

  add(run: ArenaRunRecord): void {
    this.runs.set(run.runId, run);
    this.changed();
  }

  get(runId: string): ArenaRunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Every run, newest first: the order a list reads in. */
  list(): ArenaRunRecord[] {
    return [...this.runs.values()].sort((left, right) => right.createdAt - left.createdAt);
  }

  remove(runId: string): boolean {
    const removed = this.runs.delete(runId);
    if (removed) this.changed();
    return removed;
  }

  /**
   * Applies one mutation to a contestant, then signals. The contestant's record is mutated in
   * place, so a caller holding the run sees its own change; false when the run or the contestant
   * is not there, which is a caller's bookkeeping bug rather than a run's state.
   */
  updateContestant(
    runId: string,
    contestantId: string,
    apply: (contestant: ArenaContestantRecord, now: number) => void,
  ): boolean {
    const run = this.runs.get(runId);
    const contestant = run?.contestants.find((c) => c.contestantId === contestantId);
    if (!run || !contestant) return false;
    apply(contestant, this.now());
    this.changed();
    return true;
  }

  /** Applies one mutation to a run itself, then signals; false when there is no such run. */
  updateRun(runId: string, apply: (run: ArenaRunRecord) => void): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    apply(run);
    this.changed();
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("agent feed arena registry listener failed", error);
      }
    }
  }
}
