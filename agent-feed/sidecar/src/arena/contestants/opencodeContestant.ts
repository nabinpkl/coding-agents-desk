// Driving one opencode contestant: make the serve session in the contestant's worktree, send
// the run's prompt, and wait for the turn to close.
//
// Everything here is the sidecar's own machinery used as a client. `createSession` opens a
// session on this machine's one serve, which the pool registers in the catalog -- so a
// contestant shows in every session surface as an ordinary session from its first moment, the
// arena's whole relationship with the panel's existing surfaces. `send` delivers the prompt,
// and the timeline subscription carries the events (whose tool_use blocks name the files the
// contestant touched) and the moments worth asking whether the turn is over.
//
// Whether it IS over is the serve's own answer, not the projection's. The serve ends every
// turn with an `idle` message carrying an `outcome` (`succeeded` or `failed`), and a failed
// turn's assistant message names the cause. The projection's run state cannot stand in for
// it, measured both ways: a turn the provider refused in half a second (a spent quota) never
// published `running` at all -- only `idle`, the user row, and an empty assistant row -- so a
// "saw running, then idle" rule waited out the whole timeout on it; and the mapper counts a
// user row or a finished tool step as closed, so `idle` can arrive before the model has
// answered. So every envelope that is not `running` is a prompt to read the marker, and the
// marker alone closes the contestant.
//
// The backend arrives as a narrow interface rather than the whole `AgentBackend`: this module
// needs exactly four operations, and naming them keeps a fake in tests from growing a fake of
// the rest of the interface.
//
// The session is a plain one, run as the serve's own `build` agent under its own rules, as any
// session the panel makes is (ADR-0139). What the contestant reached outside its worktree is a
// fact read off its events at close (`outsideReaches`), not something refused.

import type {
  AgentCommandReceipt,
  AgentSessionDescriptor,
  TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";
import type { ContestantPlan, ContestantResult } from "@/arena/contestants/contestantDriver";
import { readOpencodeTail } from "@/agents/opencode/opencodeHistory";
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

export class OpencodeContestantError extends Error {}

/** Where the serve says the latest turn stands: still open, or closed with what it came to. */
export type OpencodeTurnOutcome =
  | { closed: false }
  | { closed: true; failure: string | null };

/**
 * Reads the latest turn's outcome off the serve's own messages, oldest first.
 *
 * Only messages after the last user message count: the session is the contestant's own and
 * holds one prompt, but a marker from before it would describe a turn that is not this one.
 * Read loosely, because these messages arrive off a raw history read, not the client.
 */
export function turnOutcomeOf(messages: readonly unknown[]): OpencodeTurnOutcome {
  let start = 0;
  messages.forEach((message, index) => {
    if (typeOf(message) === "user") start = index + 1;
  });
  const turn = messages.slice(start);
  const marker = turn.find((message) => typeOf(message) === "idle") as
    | { outcome?: unknown }
    | undefined;
  if (!marker) return { closed: false };
  if (marker.outcome !== "failed") return { closed: true, failure: null };
  const errored = [...turn].reverse().find((message) => {
    const error = (message as { error?: unknown }).error;
    return typeOf(message) === "assistant" && error && typeof error === "object";
  }) as { error: { type?: unknown; message?: unknown } } | undefined;
  const kind = typeof errored?.error.type === "string" ? errored.error.type : null;
  const said = typeof errored?.error.message === "string" ? errored.error.message : null;
  const failure = kind && said ? `${kind}: ${said}` : said ?? kind ?? "the serve reported the turn failed";
  return { closed: true, failure };
}

function typeOf(message: unknown): unknown {
  return message && typeof message === "object" ? (message as { type?: unknown }).type : undefined;
}

/** Whether the serve holds a prompt in the session: any user message at all. */
export function promptSentOf(messages: readonly unknown[]): boolean {
  return messages.some((message) => typeOf(message) === "user");
}

/** `promptSentOf` the session as the serve holds it now. */
export async function opencodePromptSent(sessionId: string): Promise<boolean> {
  return promptSentOf(await readOpencodeTail(sessionId));
}

async function readTurnOutcome(sessionId: string): Promise<OpencodeTurnOutcome> {
  return turnOutcomeOf(await readOpencodeTail(sessionId));
}

/**
 * How long after an inconclusive read to read once more. The envelope that wakes the check
 * comes from a refresh the serve's own idle event triggered, and nothing orders that refresh
 * after the marker's write; a turn whose last envelope arrived a moment before its marker
 * would otherwise wait for an envelope that is never coming. One follow-up per wake, not a
 * poll: an open turn keeps producing envelopes, and each of them asks again.
 */
const RECHECK_MS = 1000;

/** How an opencode contestant reads its turn's outcome; overridden in tests. */
export interface OpencodeContestantOptions {
  turnOutcome?: (sessionId: string) => Promise<OpencodeTurnOutcome>;
  /** Whether a session already holds its prompt, for a contestant picked back up after a restart. */
  promptSent?: (sessionId: string) => Promise<boolean>;
  recheckMs?: number;
}

/**
 * Drives one contestant and resolves when its turn has closed; rejects with the serve's own
 * reason when the turn failed.
 */
export async function runOpencodeContestant(
  backend: OpencodeContestantBackend,
  plan: ContestantPlan,
  options: OpencodeContestantOptions = {},
): Promise<ContestantResult> {
  const sessionId = await openOpencodeContestant(backend, plan);
  plan.onSessionId(sessionId);
  return driveOpencodeTurn(backend, sessionId, plan, options);
}

/**
 * Makes the contestant's session on the serve, as the serve's own agent with its own rules -- a
 * plain session, like any the panel makes (ADR-0139) -- and answers its id.
 */
export async function openOpencodeContestant(
  backend: OpencodeContestantBackend,
  plan: ContestantPlan,
): Promise<string> {
  const descriptor = await backend.createSession(plan.requestId, plan.worktreePath);
  return descriptor.sessionId;
}

/**
 * Sends the prompt to a session that exists and resolves when the turn has closed.
 *
 * The subscription is opened BEFORE the send, so no event can land between the send and the
 * listen: a fast turn's whole life can fit inside that gap, and a listener attached late would
 * report a turn that happened without it. `alreadySent` is a turn a restarted sidecar is picking
 * back up: nothing is sent, and the turn is only watched, from the session's first event.
 */
export async function driveOpencodeTurn(
  backend: OpencodeContestantBackend,
  sessionId: string,
  plan: ContestantPlan,
  options: OpencodeContestantOptions & { alreadySent?: boolean } = {},
): Promise<ContestantResult> {
  const turnOutcome = options.turnOutcome ?? readTurnOutcome;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  // Ids are the projection's own: a snapshot re-states rows an upsert already delivered, so the
  // collected turn is deduped by id in insertion order rather than appended raw.
  const collected = new Map<string, ActivityEvent>();
  let sent = false;
  let checking = false;
  let wanted = false;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  type Outcome = { failure: string | null } | { timedOut: true };
  let resolveFinished: (outcome: Outcome) => void = () => {};
  const finished = new Promise<Outcome>((resolve) => {
    resolveFinished = resolve;
  });
  const settle = (outcome: Outcome): void => {
    if (closed) return;
    closed = true;
    resolveFinished(outcome);
  };

  // One read in flight at a time; a wake that lands during a read is folded into one more read
  // after it rather than racing it.
  const check = async (): Promise<void> => {
    if (!sent || closed) return;
    if (checking) {
      wanted = true;
      return;
    }
    checking = true;
    try {
      const outcome = await turnOutcome(sessionId);
      if (outcome.closed) {
        settle({ failure: outcome.failure });
        return;
      }
      if (recheck) clearTimeout(recheck);
      recheck = setTimeout(() => void check(), recheckMs);
      recheck.unref?.();
    } catch (error) {
      settle({ failure: `reading the turn's outcome failed: ${String(error)}` });
    } finally {
      checking = false;
      if (wanted && !closed) {
        wanted = false;
        void check();
      }
    }
  };

  const unsubscribe = await backend.subscribe(sessionId, 0, (envelope) => {
    for (const event of envelope.events) collected.set(event.id, event);
    if (envelope.runState !== "running") void check();
  });

  let outcome: Outcome;
  const timer = setTimeout(() => settle({ timedOut: true }), plan.turnTimeoutMs);
  timer.unref?.();
  try {
    if (!options.alreadySent) await backend.send(sessionId, plan.requestId, plan.prompt, "next");
    sent = true;
    // Envelopes that arrived during the send were not allowed to ask; ask once for them.
    void check();
    outcome = await finished;
  } finally {
    clearTimeout(timer);
    if (recheck) clearTimeout(recheck);
    closed = true;
    unsubscribe();
  }

  if ("timedOut" in outcome) {
    throw new OpencodeContestantError(
      `contestant did not close its turn within ${plan.turnTimeoutMs}ms`,
    );
  }
  if (outcome.failure !== null) throw new OpencodeContestantError(outcome.failure);

  return {
    sessionId,
    events: [...collected.values()],
    usage: backend.sessionUsage?.(sessionId) ?? null,
  };
}
