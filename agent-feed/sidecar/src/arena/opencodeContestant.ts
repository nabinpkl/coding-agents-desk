// Driving one opencode contestant: make the serve session in the contestant's worktree, send
// the run's prompt, and wait for the turn to close.
//
// Everything here is the sidecar's own machinery used as a client. `createSession` opens a
// session on this machine's one serve, which the pool registers in the catalog -- so a
// contestant shows in every session surface as an ordinary session from its first moment, the
// arena's whole relationship with the panel's existing surfaces. `send` delivers the prompt,
// and the timeline subscription carries both halves of what the arena needs from the turn: the
// events (whose tool_use blocks name the files the contestant touched) and the completion
// signal (runState returning to idle with an empty queue).
//
// The completion signal is deliberately "saw running, then idle". A projection that was idle
// before the prompt would otherwise read as finished the moment `send` returned, and a turn
// that never opened would close a contestant that never ran.
//
// The backend arrives as a narrow interface rather than the whole `AgentBackend`: this module
// needs exactly four operations, and naming them keeps a fake in tests from growing a fake of
// the rest of the interface.

import type {
  AgentCommandReceipt,
  AgentSessionDescriptor,
  TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";
import type { ActivityEvent, TokenUsage } from "@/transcripts/transcriptTypes";

/** What driving one contestant needs of an opencode backend. */
export interface OpencodeContestantBackend {
  createSession(requestId: string, projectPath: string): Promise<AgentSessionDescriptor>;
  send(
    sessionId: string,
    requestId: string,
    text: string,
    delivery: "next",
  ): Promise<AgentCommandReceipt>;
  subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (envelope: TimelineEnvelope) => void,
  ): Promise<() => void>;
  sessionUsage?(sessionId: string): TokenUsage | null;
}

/** One contestant's drive, as the service plans it. */
export interface OpencodeContestantPlan {
  prompt: string;
  worktreePath: string;
  /** Unique per run and contestant: the backend deduplicates creations by it. */
  requestId: string;
  /** How long the turn may run before the contestant is abandoned as failed. */
  turnTimeoutMs: number;
  /**
   * Called the moment the session exists, which is before the turn has run. The service hangs
   * the session id on the contestant's record here, so a reader can open the session while it
   * duels rather than only after it has closed.
   */
  onSessionId?: (sessionId: string) => void;
}

/** What one contestant's turn left: its session, its events, and its usage at close. */
export interface OpencodeContestantResult {
  sessionId: string;
  /** The turn's events, snapshot rows and upserts merged by id, in projection order. */
  events: ActivityEvent[];
  usage: TokenUsage | null;
}

export class OpencodeContestantError extends Error {}

/**
 * Drives one contestant and resolves when its turn has closed.
 *
 * The subscription is opened BEFORE the send, so no event can land between the send and the
 * listen: a fast turn's whole life can fit inside that gap, and a listener attached late would
 * report a turn that happened without it.
 */
export async function runOpencodeContestant(
  backend: OpencodeContestantBackend,
  plan: OpencodeContestantPlan,
): Promise<OpencodeContestantResult> {
  const descriptor = await backend.createSession(plan.requestId, plan.worktreePath);
  const sessionId = descriptor.sessionId;
  plan.onSessionId?.(sessionId);

  // Ids are the projection's own: a snapshot re-states rows an upsert already delivered, so the
  // collected turn is deduped by id in insertion order rather than appended raw.
  const collected = new Map<string, ActivityEvent>();
  let sawRunning = false;
  let settled = false;
  let timedOut = false;
  let release: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = (): void => {
    if (!settled) {
      settled = true;
      release?.();
    }
  };

  const unsubscribe = await backend.subscribe(sessionId, 0, (envelope) => {
    for (const event of envelope.events) collected.set(event.id, event);
    if (envelope.runState === "running") {
      sawRunning = true;
    } else if (
      sawRunning &&
      envelope.runState === "idle" &&
      envelope.queue.steer === 0 &&
      envelope.queue.followUp === 0
    ) {
      done();
    }
  });

  try {
    await backend.send(sessionId, plan.requestId, plan.prompt, "next");
    // The turn is now the serve's to run; the subscription is the only thing watching it. A
    // projection already idle at this point has not run yet, and only the signal above closes it.
    const timer = setTimeout(() => {
      timedOut = true;
      done();
    }, plan.turnTimeoutMs);
    timer.unref?.();
    await finished;
    clearTimeout(timer);
  } finally {
    unsubscribe();
  }

  if (timedOut) {
    throw new OpencodeContestantError(
      `contestant did not close its turn within ${plan.turnTimeoutMs}ms`,
    );
  }

  return {
    sessionId,
    events: [...collected.values()],
    usage: backend.sessionUsage?.(sessionId) ?? null,
  };
}
