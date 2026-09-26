// What the meter reads, and under which model, from one serve answer.
//
// Split out of the session pool because this is the one calculation there with a rule rather
// than a sequence: session totals are an odometer, the meter wants the window, and the two come
// apart in ways the reader can see. Three of them, each measured:
//
// - Totals accumulate every turn's cache re-read, so on a long session they read in the
//   hundreds of millions against a million-token window. The window is summed from the
//   messages that are actually in context; the totals only seed a session that has never
//   reported a window at all.
// - A completed compaction with no turn reporting tokens after it leaves nothing to sum, and
//   the right answer is no meter rather than the pre-compaction number, which describes a
//   window that no longer exists. That is the TUI's own gap behavior.
// - Otherwise the previous reading stands, because a batch carrying no tokens is not evidence
//   that the count changed. The cost rides it either way, since the serve prices the session
//   whether or not the turn that spent it has landed.
//
// The denominator is the model's context window, resolved from the serve's own model list and
// never invented: a fraction of a guessed bar reads as authoritative and is not, so an
// unknown model is a count with no bar until the first lookup lands.

import type { OpencodeModelLimits } from "@/agents/opencode/opencodeModelLimits";
import { currentWindowTokens, lastCompletedCompactionIndex } from "@/agents/opencode/opencodeServeCalls";
import type { SessionMessage } from "@opencode-ai/sdk/v2/client";
import type { TokenUsage } from "@/transcripts/transcriptTypes";

/** The serve's own `session.get` answer, as far as the meter reads it. */
export interface OpencodeServeSession {
  model?: { id: string; providerID: string } | null;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  } | null;
  cost?: unknown;
}

export interface OpencodeMeterReading {
  model: string;
  usage: TokenUsage | null;
}

export async function readOpencodeMeter(options: {
  session: OpencodeServeSession | undefined;
  history: readonly SessionMessage[];
  previous: TokenUsage | null;
  limits: OpencodeModelLimits;
  now: () => number;
}): Promise<OpencodeMeterReading | null> {
  const { session, history, previous, limits, now } = options;
  // Named whenever the serve names one, whether or not tokens rode along: a fresh session
  // reports no totals yet, and usage still blanks across the post-compaction gap, but neither
  // ever changes the model.
  const servedModel = session?.model;
  const model = servedModel ? `${servedModel.providerID}/${servedModel.id}` : null;
  if (!session?.tokens || !session.model) {
    return model === null ? null : { model, usage: previous };
  }
  const tokens = session.tokens;
  const modelKey = `${session.model.providerID}/${session.model.id}`;
  const totals = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  // Read straight off the serve, never computed: cost math belongs to the side that prices.
  // Absent, rather than zero, when the serve names none.
  const raw = session.cost;
  const cost = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  const windowTokens = currentWindowTokens(history);
  const limit = await limits.limit(modelKey);
  if (windowTokens !== null) {
    return { model: modelKey, usage: { current: windowTokens, limit, updatedAt: now(), model: modelKey, cost } };
  }
  if (lastCompletedCompactionIndex(history) !== -1) return { model: modelKey, usage: null };
  return {
    model: modelKey,
    usage: {
      current: previous?.current ?? totals,
      limit,
      updatedAt: now(),
      model: modelKey,
      cost: cost ?? previous?.cost,
    },
  };
}
