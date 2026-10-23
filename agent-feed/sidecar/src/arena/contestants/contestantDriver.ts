// The seam between a run's orchestration and the harness that drives one contestant.
//
// Extracted when the second driver arrived, not before: one implementation earns no
// interface, and the shape the first one would have invented alone (completion off a
// projection's run state) is not the shape the second needed (completion off a process
// exit). What survived both is what belongs here -- the plan a run hands a driver, and
// the result it hands back -- and each driver owns everything harness-specific below it.
// The terminals mode added a third and fourth driver and one optional member, `terminal`,
// rather than a second contract: a pane is how the turn is driven, not what the run records.

import type { ArenaContestantSource, ArenaLaneStance } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent, TokenUsage } from "@/transcripts/transcriptTypes";

/** One contestant's drive, as the run plans it. Same shape for every harness. */
export interface ContestantPlan {
  /** What the lane is sent, its stance's words already around the run's prompt. */
  prompt: string;
  /** Which side the lane takes; a driver reads it only for the tools an against lane runs without. */
  stance: ArenaLaneStance;
  worktreePath: string;
  /** The model the lane was asked to run, or null for its harness's default. */
  model: string | null;
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
  /**
   * The session a later prompt of the run continues, headless only: the driver sends this turn
   * into it rather than making a session. A terminals contestant continues through `terminal`'s
   * resume instead, since its session lives in its pane.
   */
  continues?: string;
  /** Present in the terminals mode only, and what makes a run's start one moment for all. */
  terminal?: ContestantTerminal;
}

/**
 * What a run gives a contestant it drives in a tmux pane.
 *
 * The pane is announced the moment it exists, so a reader can watch the harness load and answer
 * whatever it asks on the way up. `ready` is the start line: a contestant calls it once its harness
 * can take a prompt, and it resolves -- with the prompt -- when every contestant of the run has
 * called it or dropped out AND the run has its prompt, so the one prompt is typed into all of them
 * together and no contestant's clock starts while another is still loading. A run may open its
 * lanes before it has a prompt at all; the prompt is what the reader types once they are up. The
 * plan's own `prompt` is therefore not the one to send: `ready` answers that.
 */
export interface ContestantTerminal {
  /** What the session and its pane are called, so a reader can tell contestants apart anywhere. */
  label: string;
  onPane: (pane: string, sessionId: string) => void;
  ready: () => Promise<string>;
  /**
   * A contestant a restarted sidecar is picking back up: its pane and session already exist and
   * are not started again. `prompted` is that its run had already let it go with the prompt, so it
   * never calls `ready` and its turn is watched to its close; the plan's `prompt` is that prompt.
   */
  resume?: ContestantResume;
}

export interface ContestantResume {
  pane: string;
  sessionId: string;
  prompted: boolean;
}

/** What a contestant's status moves through at the start line, as the run records it. */
export interface StartLineMarks {
  pane(pane: string, sessionId: string): void;
  ready(): void;
  /** The prompt has been handed over: the contestant's clock starts here. */
  running(): void;
}

/**
 * A contestant's terminal hooks at its run's start line, and `done` for when its drive ends: a
 * contestant that never arrived leaves then, so nobody waits on it. One resumed after its prompt
 * is not at the line at all, and neither arrives nor leaves.
 */
export function startLineTerminal(options: {
  label: string;
  line: StartLine;
  marks: StartLineMarks;
  resume?: ContestantResume;
}): { terminal: ContestantTerminal; done: () => void } {
  const { label, line, marks, resume } = options;
  let atLine = !resume?.prompted;
  const terminal: ContestantTerminal = {
    label,
    onPane: (pane, sessionId) => marks.pane(pane, sessionId),
    ready: async () => {
      marks.ready();
      atLine = false;
      const prompt = await line.arrive();
      // The clock starts at the prompt, not at the pane: a harness's load time, and a reader
      // answering its startup question, are not part of the turn being compared.
      marks.running();
      return prompt;
    },
    ...(resume ? { resume } : {}),
  };
  return {
    terminal,
    done: () => {
      if (atLine) {
        atLine = false;
        line.leave();
      }
    },
  };
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
 * prompt) or leaves (it failed before it could), and the arrivals are let go together, with the
 * prompt, once the last one has done either and the run has been given its prompt. Each contestant
 * does exactly one of arrive or leave; the prompt is given once.
 *
 * `abort` is a run removed while it waits for its prompt: every arrival, present and future,
 * rejects with its reason, so a contestant at the line fails rather than waiting forever.
 */
export class StartLine {
  private waiting: number;
  private prompt: string | null;
  private readonly open: Promise<string>;
  private release: (prompt: string) => void = () => {};
  private refuse: (reason: Error) => void = () => {};

  constructor(contestants: number, prompt: string | null) {
    this.waiting = contestants;
    this.prompt = prompt;
    this.open = new Promise<string>((resolve, reject) => {
      this.release = resolve;
      this.refuse = reject;
    });
    // Nobody may be waiting when it is refused; that rejection is still nobody's to report.
    this.open.catch(() => undefined);
    this.check();
  }

  /** Whether the run has its prompt. */
  get prompted(): boolean {
    return this.prompt !== null;
  }

  arrive(): Promise<string> {
    this.waiting -= 1;
    this.check();
    return this.open;
  }

  leave(): void {
    this.waiting -= 1;
    this.check();
  }

  /** One more contestant to wait for: a lane added to a run that has not had its prompt. */
  join(): void {
    if (this.prompt !== null) throw new Error("this run already has its prompt");
    this.waiting += 1;
  }

  give(prompt: string): void {
    if (this.prompt !== null) throw new Error("this run already has its prompt");
    this.prompt = prompt;
    this.check();
  }

  abort(reason: Error): void {
    this.refuse(reason);
  }

  private check(): void {
    if (this.waiting <= 0 && this.prompt !== null) this.release(this.prompt);
  }
}
