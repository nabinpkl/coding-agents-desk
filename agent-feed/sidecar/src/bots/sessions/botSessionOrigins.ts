// Where a Bot's session came from, when it was made from another one: a fork, or a handover.
//
// Kept on the Bot rather than read back off the session, because nothing the two harnesses write
// says it in one shape: a Claude fork's transcript is its source's records copied, and an opencode
// handover is a fresh session whose first prompt only describes another one. The card draws it as
// an icon before the name, which is what lets the title stay `Anchor (task)` with no `(fork)` or
// `(handover)` of its own.

import type { BotRecord, BotSessionOrigin, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { BotStore } from "@/bots/botStore";
import { sessionKey } from "@/bots/botIdempotency";

/** A fork's origin from what its launch branches from; none for a launch that branches from nothing. */
export function forkOrigin(from: BotSessionRef | undefined): BotSessionOrigin | undefined {
  return from ? { kind: "fork", from: { source: from.source, sessionId: from.sessionId } } : undefined;
}

/** The record with the origin of the session at `key` set, or the record itself when there is none. */
export function withSessionOrigin(bot: BotRecord, key: string, origin: BotSessionOrigin | undefined): BotRecord {
  if (!origin) return bot;
  return { ...bot, sessionOrigins: { ...bot.sessionOrigins, [key]: origin } };
}

/**
 * Records that `to` continues `from` by a handover, on every Bot that holds `from`.
 *
 * By source rather than by Bot, as the agent log's carry is (`carrySessionLog`): one direction of a
 * handover attaches its successor inside the request and the other is attached by the panel's next
 * call, and both land on the Bot the source is on. An entry written ahead of that attach is
 * harmless, since entries outlive detaching anyway.
 */
export async function recordHandoverOrigin(store: BotStore, from: BotSessionRef, to: BotSessionRef): Promise<void> {
  const fromKey = sessionKey(from);
  const origin: BotSessionOrigin = { kind: "handover", from: { source: from.source, sessionId: from.sessionId } };
  const holds = (bot: BotRecord) => bot.sessionRefs.some((ref) => sessionKey(ref) === fromKey);
  if (!(await store.snapshot()).bots.some(holds)) return;
  await store.mutate((snapshot) => ({
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots: snapshot.bots.map((bot) => (holds(bot) ? withSessionOrigin(bot, sessionKey(to), origin) : bot)),
    },
    value: undefined,
  }));
}
