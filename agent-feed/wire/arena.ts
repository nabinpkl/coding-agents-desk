// Arena runs: one prompt fanned out to contestants, and the facts each left behind.
//
// A run is recording-only. The arena never scores and never ranks; it records how long each
// contestant took, which files its tools touched, what it spent, and what diff it left, and the
// panel shows those facts. Judgment is a reader's act, and a reader judges from the session
// itself: a contestant's session is an ordinary catalog session that every existing session
// surface already renders, so the arena adds the grouping and the facts, not a new session viewer.
//
// Statuses travel, facts wait. `gitDiff` and the file lists scale with the work a prompt asked
// for, so they ride the detail route on demand rather than every status push, the same split the
// transcript itself keeps between its list and its body.

/**
 * The harnesses an arena run can drive a contestant with. A source the arena cannot drive is
 * refused with 400 naming it, rather than queued for a driver that does not exist.
 */
export type ArenaContestantSource = "opencode" | "claude";

export type ArenaContestantStatus = "preparing" | "running" | "closed" | "failed";

/** One contestant of a run, as a status surface needs it: identity and where it stands. */
export interface ArenaContestantSummary {
  contestantId: string;
  source: ArenaContestantSource;
  /** The session this contestant is, once its backend has made one; null until then. */
  sessionId: string | null;
  worktreePath: string;
  status: ArenaContestantStatus;
  startedAt: number | null;
  closedAt: number | null;
  /**
   * Wall time from the contestant's session existing to its turn closing. A rough fact, not a
   * benchmark: the send that opens the turn lands milliseconds after the session does, and
   * machine load rides the number wherever it runs.
   */
  durationMs: number | null;
  /** Why a contestant failed, one line; null otherwise. */
  error: string | null;
}

/** A run, as a list or a stream needs it: what was asked and where each contestant stands. */
export interface ArenaRunSummary {
  runId: string;
  prompt: string;
  repoPath: string;
  baseRef: string;
  createdAt: number;
  contestants: ArenaContestantSummary[];
}

/** Facts a contestant left behind, read on demand. */
export interface ArenaContestantDetail extends ArenaContestantSummary {
  /** Context occupancy as of the contestant's close, or null when its backend reported none. */
  contextTokens: number | null;
  /** The session's reported spend in USD, or null when its backend reported none. Cost math
   * belongs to the side that prices; the arena repeats the figure, it never computes one. */
  costUsd: number | null;
  /** Paths the contestant's read-like tools named, in first-mention order, deduplicated. */
  filesRead: string[];
  /** Paths the contestant's write-like tools named, in first-mention order, deduplicated. */
  filesWritten: string[];
  /** `git diff <baseRef>` in the contestant's worktree at close, bounded in size. Null while
   * the contestant runs, and for one that failed before its turn closed. Untracked files a
   * contestant left are not in it; `filesWritten` is where they are still named. */
  gitDiff: string | null;
}

export interface ArenaRunDetail extends ArenaRunSummary {
  contestants: ArenaContestantDetail[];
}

/**
 * `POST /api/arena/runs`. Each contestant names the harness that drives it, so one run can
 * duel two of the same harness or one of each.
 */
export interface ArenaCreateRunRequest {
  prompt: string;
  /** Absolute path of the git repository the contestants get worktrees of. */
  repoPath: string;
  /** The ref every contestant's worktree starts at; "HEAD" when absent. */
  baseRef?: string;
  contestants: { source: ArenaContestantSource }[];
}

/** One message of the arena status stream: the whole run list, pushed on every change. */
export interface ArenaRunsStreamMessage {
  type: "runs";
  runs: ArenaRunSummary[];
}
