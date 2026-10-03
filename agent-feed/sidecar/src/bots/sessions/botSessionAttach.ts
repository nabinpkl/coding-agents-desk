// Putting sessions onto a Bot: ones that already exist, recorded in one mutation.
//
// Split from the registry the way `detachRefs` is: the registry decides what the command may do
// (whose directory these sessions belong to needs disk reads, so it stays outside), and this is
// the pure store shape "this Bot now holds those references" with its slots and anchors spent
// beside them.

import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import { appendIdempotency, priorBot, sessionKey } from "@/bots/botIdempotency";
import { ensureSessionSlots } from "@/bots/sessions/botSessionSlots";
import { allocateAnchors } from "@/bots/sessions/botTitleNormalize";
import { spentAnchors } from "@/bots/sessions/botSessionLaunch";
import { BotConflictError, BotNotFoundError } from "@/bots/botTypes";

/**
 * Records references a Bot now holds, refusing ones it already has or may not claim.
 *
 * A replay answers with the Bot the first run made and starts nothing. `outside` names a
 * reference that has never worked anywhere the Bot may claim, decided against the disk before
 * this runs; an empty `refs` with no launch records only the idempotency, so the launch after it
 * knows the request is new. A session attached from outside arrives with whatever title it has;
 * the anchor it will normalize to is spent here, beside the slot, so the next rename already
 * knows its name.
 */
export function attachRefs(
  snapshot: StoredBotSnapshot,
  botId: string,
  refs: readonly BotSessionRef[],
  outside: BotSessionRef | undefined,
  idempotencyKey: string,
  signature: string,
): { snapshot: StoredBotSnapshot; value: { bot: BotRecord; fresh: boolean } } {
  const prior = priorBot(snapshot, idempotencyKey, signature);
  if (prior) return { snapshot, value: { bot: prior, fresh: false } };
  const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
  if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
  const bot = snapshot.bots[index]!;
  if (refs.length === 0) {
    return {
      snapshot: {
        ...snapshot,
        revision: snapshot.revision + 1,
        idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
      },
      value: { bot, fresh: true },
    };
  }
  if (outside) {
    throw new BotConflictError(
      "every attached session must have worked in the Bot's directory, or in a git worktree of it",
    );
  }
  const attached = new Set(bot.sessionRefs.map(sessionKey));
  const duplicate = refs.find((ref) => attached.has(sessionKey(ref)));
  if (duplicate) throw new BotConflictError(`session ${sessionKey(duplicate)} is already attached to this Bot`);

  const heldRefs = [...bot.sessionRefs, ...refs];
  const updated: BotRecord = {
    ...bot,
    sessionRefs: heldRefs,
    ...ensureSessionSlots(bot, heldRefs),
    sessionAnchors: allocateAnchors(bot.sessionAnchors, refs, spentAnchors(snapshot.bots)),
  };
  const bots = [...snapshot.bots];
  bots[index] = updated;
  return {
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots,
      idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
    },
    value: { bot: updated, fresh: true },
  };
}
