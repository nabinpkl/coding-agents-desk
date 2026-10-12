// The seam between a run's orchestration and the harness that drives one contestant.
//
// Extracted when the second driver arrived, not before: one implementation earns no
// interface, and the shape the first one would have invented alone (completion off a
// projection's run state) is not the shape the second needed (completion off a process
// exit). What survived both is what belongs here -- the plan a run hands a driver, and
// the result it hands back -- and each driver owns everything harness-specific below it.
// The terminals mode added a third and fourth driver and one optional member, `terminal`,
// rather than a second contract: a pane is how the turn is driven, not what the run records.

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
  /** Present in the terminals mode only, and what makes a run's start one moment for all. */
  terminal?: ContestantTerminal;
}

/**
 * What a run gives a contestant it drives in a tmux pane.
 *
 * The pane is announced the moment it exists, so a reader can watch the harness load and answer
 * whatever it asks on the way up. `ready` is the start line: a contestant calls it once its harness
 * can take a prompt, and it resolves when every contestant of the run has called it or dropped
 * out, so the one prompt is typed into all of them together and no contestant's clock starts while
 * another is still loading.
 */
export interface ContestantTerminal {
  /** What the session and its pane are called, so a reader can tell contestants apart anywhere. */
  label: string;
  onPane: (pane: string, sessionId: string) => void;
  ready: () => Promise<void>;
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

/**
 * The terminals mode's start line: every contestant either arrives (its harness can take the
 * prompt) or leaves (it failed before it could), and the arrivals are let go together once the
 * last one has done either. Each contestant does exactly one of the two.
 */
export class StartLine {
  private waiting: number;
  private readonly open: Promise<void>;
  private release: () => void = () => {};

  constructor(contestants: number) {
    this.waiting = contestants;
    this.open = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    if (contestants <= 0) this.release();
  }

  arrive(): Promise<void> {
    this.settleOne();
    return this.open;
  }

  leave(): void {
    this.settleOne();
  }

  private settleOne(): void {
    this.waiting -= 1;
    if (this.waiting <= 0) this.release();
  }
}
