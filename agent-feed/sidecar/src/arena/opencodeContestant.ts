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
// The session is CONFINED from its first moment, to what a Claude contestant may do (see
// `claudeContestant.ts`): read, edit, search and run a shell in its worktree, and nothing
// else. A serve session otherwise runs as the `build` agent, whose rules allow every tool and,
// on this machine's config, every directory -- web fetch, MCP servers, subagents and plugin
// tools included. The rules ride the create request, so no session exists without them.
// Session rules are read after the agent's and the last match wins, so one leading deny-all and
// the allows after it decide every action. Measured on the live serve (2.0.16, 2026-10-12) by
// asking it to judge actions against a session holding these rules: read, edit and bash in the
// worktree allowed; webfetch, websearch, an MCP tool, task, question and a directory outside
// the worktree denied. When the rules cannot be read, no session is created at all.

import type {
  AgentCommandReceipt,
  AgentSessionDescriptor,
  TimelineEnvelope,
} from "@agentdesk/agent-feed-wire";
import type { ContestantPlan, ContestantResult } from "@/arena/contestantDriver";
import type { OpencodePermissionRule } from "@/agents/opencode/opencodeAgentBackend";
import { serveGet } from "@/agents/opencode/opencodeClient";
import { readOpencodeTail } from "@/agents/opencode/opencodeHistory";
import type { ActivityEvent, TokenUsage } from "@/transcripts/transcriptTypes";

/** What driving one contestant needs of an opencode backend. */
export interface OpencodeContestantBackend {
  createSession(
    requestId: string,
    projectPath: string,
    options: { permissions: readonly OpencodePermissionRule[] },
  ): Promise<AgentSessionDescriptor>;
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

/** The actions a contestant may take: Claude's six tools, under the serve's names. */
const CONTESTANT_ACTIONS = ["read", "edit", "glob", "grep", "list", "bash"] as const;

/** The agent a session created with none runs as. */
const SESSION_AGENT = "build";

/**
 * The rules that confine one contestant's session.
 *
 * Deny-all denies `external_directory` too, which is what keeps the file tools -- and the
 * paths the serve can read out of a shell command -- inside the worktree. It would also deny
 * the serve its own scratch directories (a long tool output is spilled to one and read back),
 * so those are re-allowed from the agent's own rules rather than spelled here: they are the
 * serve's paths, and its agent list is where it says what they are. The agent's blanket
 * `external_directory *` allow is exactly what is not carried over.
 */
export function contestantPermissions(
  agentRules: readonly OpencodePermissionRule[],
): OpencodePermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...CONTESTANT_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
    ...agentRules.filter(
      (rule) => rule.action === "external_directory" && rule.effect === "allow" && rule.resource !== "*",
    ),
  ];
}

/** The confining rules for a session that runs as the default agent. Throws when it cannot. */
async function readContestantPermissions(): Promise<OpencodePermissionRule[]> {
  const listed = await serveGet("/api/agent");
  if (listed.status < 200 || listed.status >= 300) {
    throw new Error(`agents: serve answered ${listed.status} ${listed.text.slice(0, 200)}`);
  }
  const agents = (JSON.parse(listed.text) as { data?: unknown }).data;
  const agent = Array.isArray(agents)
    ? (agents as { id?: unknown; permissions?: unknown }[]).find((one) => one.id === SESSION_AGENT)
    : undefined;
  const rules = agent?.permissions;
  return contestantPermissions(Array.isArray(rules) ? (rules as OpencodePermissionRule[]) : []);
}

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

/**
 * Drives one contestant and resolves when its turn has closed; rejects with the serve's own
 * reason when the turn failed.
 *
 * The subscription is opened BEFORE the send, so no event can land between the send and the
 * listen: a fast turn's whole life can fit inside that gap, and a listener attached late would
 * report a turn that happened without it.
 */
export async function runOpencodeContestant(
  backend: OpencodeContestantBackend,
  plan: ContestantPlan,
  options: {
    turnOutcome?: (sessionId: string) => Promise<OpencodeTurnOutcome>;
    recheckMs?: number;
    permissions?: () => Promise<OpencodePermissionRule[]>;
  } = {},
): Promise<ContestantResult> {
  const turnOutcome = options.turnOutcome ?? readTurnOutcome;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  let permissions: OpencodePermissionRule[];
  try {
    permissions = await (options.permissions ?? readContestantPermissions)();
  } catch (error) {
    throw new OpencodeContestantError(`could not read the rules that confine a contestant, so none was started: ${String(error)}`);
  }
  const descriptor = await backend.createSession(plan.requestId, plan.worktreePath, { permissions });
  const sessionId = descriptor.sessionId;
  plan.onSessionId(sessionId);

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
    await backend.send(sessionId, plan.requestId, plan.prompt, "next");
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
