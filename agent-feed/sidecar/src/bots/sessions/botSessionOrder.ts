// Putting a Bot's sessions in a new order, which is the third thing that can happen to its
// curation after attaching and detaching.
//
// Its own file rather than a third arm of `botSessionRemoval.ts`, because nothing here removes
// anything: what this refuses to change is the SET of references, and changing that set is the
// whole of what the removal module does.

import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import { appendIdempotency, priorBot, sessionKey } from "@/bots/botIdempotency";
import { BotConflictError, BotNotFoundError } from "@/bots/botTypes";

/**
 * Stands this Bot's references in the order given, refusing anything that is not exactly them.
 *
 * The refusals are the point of the function rather than guards on it. A reorder is the one Bot
 * command whose caller has to have read the roster first, so the interesting failure is not a
 * malformed request but a stale one -- a panel that rendered a card, and is now naming an order
 * taken before somebody else attached a session to the same Bot. Every way of being generous
 * there loses something silently: taking the order as complete would drop the session that
 * arrived, appending the remainder would invent a position for it, and reordering by index would
 * move a different session than the reader dragged.
 *
 * So the whole order is named and any gap is a refusal the caller can retry against the roster it
 * has just been handed. Two of them, because they are two different mistakes: a reference this Bot
 * does not hold is a request about the wrong Bot, and a short list is a request about the right Bot
 * at the wrong time.
 *
 * The STORED references are what land, not the ones that came off the wire. They are the same two
 * fields by the time they get here, and keeping the stored objects means this function can never
 * be the way something extra is written into a record.
 */
export function reorderRefs(
  snapshot: StoredBotSnapshot,
  botId: string,
  refs: readonly BotSessionRef[],
  idempotencyKey: string,
  signature: string,
): { snapshot: StoredBotSnapshot; value: BotRecord } {
  const prior = priorBot(snapshot, idempotencyKey, signature);
  if (prior) return { snapshot, value: prior };
  const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
  if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
  const bot = snapshot.bots[index]!;

  const held = new Map(bot.sessionRefs.map((ref) => [sessionKey(ref), ref]));
  const wanted = refs.map(sessionKey);
  const absent = wanted.find((key) => !held.has(key));
  if (absent) throw new BotNotFoundError(`session ${absent} is not attached to this Bot`);
  // A conflict rather than a bad request: the command is well formed and was true of the Bot the
  // caller read. What changed is the Bot. Duplicates cannot reach this -- the normalizer refuses
  // them -- so equal counts over a subset is the whole of the permutation check.
  if (wanted.length !== held.size) {
    throw new BotConflictError(
      `sessionRefs must name all ${held.size} of this Bot's sessions; ${wanted.length} were given`,
    );
  }

  const updated: BotRecord = { ...bot, sessionRefs: wanted.map((key) => held.get(key)!) };
  const bots = [...snapshot.bots];
  bots[index] = updated;
  return {
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots,
      idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
    },
    value: updated,
  };
}
