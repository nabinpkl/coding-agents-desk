// The seam between a run's orchestration and the harness that drives one contestant.
//
// Extracted when the second driver arrived, not before: one implementation earns no
// interface, and the shape the first one would have invented alone (completion off a
// projection's run state) is not the shape the second needed (completion off a process
// exit). What survived both is what belongs here -- the plan a run hands a driver, and
// the result it hands back -- and each driver owns everything harness-specific below it.

import type { ArenaContestantSource } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent, TokenUsage } from "@/transcripts/transcriptTypes";

/** One contestant's drive, as the run plans it. Same shape for every harness. */
export interface ContestantPlan {
  prompt: string;
  worktreePath: string;
  /** Unique per run and contestant: whichever harness deduplicates by it. */
  requestId: string;
  /** How long the turn may run before the contestant is abandoned as failed. */
  turnTimeoutMs: number;
  /**
   * Called the moment the session exists, which for some harnesses is before the turn has
   * run. The run hangs the session id on the contestant's record here, so a reader can open
   * the session while it duels rather than only after it has closed.
   */
  onSessionId: (sessionId: string) => void;
}

/**
 * One contestant's turn, as the run records it. The events are whatever the harness's own
 * projection produced -- a driver that has none reads them back from wherever its harness
 * durably keeps them -- because the facts (which files its tools named) are read off event
 * blocks exactly once, in the run, whichever harness produced them.
 */
export interface ContestantResult {
  sessionId: string;
  /** The turn's events, one per id, in projection order. */
  events: ActivityEvent[];
  usage: TokenUsage | null;
}

/** Drives one contestant and resolves when its turn has closed. */
export type ContestantDriver = (plan: ContestantPlan) => Promise<ContestantResult>;

/** Every harness this build can drive, keyed the way a run names a contestant's source. */
export type ContestantDrivers = Readonly<Record<ArenaContestantSource, ContestantDriver>>;