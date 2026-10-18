// Where a session lands when it is dragged past its neighbours, written in the Bot's own order.
//
// Two lists meet here and they are not the same list. A card lays out the sessions the catalog
// resolved MINUS the ones this reader has taken off the canvas; the Bot's durable order also holds
// the references whose transcripts have gone missing, in among them. A drag is expressed in the
// first and has to be sent in the second, so the translation is this module's whole job -- without
// it, reordering a card with anything hidden in it would send an order that silently forgot it,
// and the sidecar would rightly refuse the lot.

import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { sessionKey } from "@/features/bots/cards/botCanvasCards";

export interface SessionReorder {
  /** Every reference the Bot holds, in the order it should now stand. */
  sessionRefs: BotSessionRef[];
  /** The one that was carried, so a failure can be reported on its own card. */
  moved: BotSessionRef;
}

/**
 * The Bot's order with `laidOut[from]` lifted out and dropped where `laidOut[to]` is standing.
 *
 * Positions come from the cards on screen, and the answer is in the full order, so the session
 * being passed is what decides the destination rather than an index: landing "at index `to`" would
 * count hidden references on the way and put the card somewhere nobody aimed at.
 *
 * Null rather than an unchanged order whenever there is nothing to do or nothing to trust -- a
 * move onto itself, an index no card sits at, a session the Bot's order does not hold. The caller
 * sends nothing on null, which is what keeps a stray drag from spending a round trip to rewrite
 * the order it already has.
 */
export function reorderSessionRefs(
  refs: readonly BotSessionRef[],
  laidOut: readonly BotSessionRef[],
  from: number,
  to: number,
): SessionReorder | null {
  if (from === to) return null;
  const carried = laidOut[from];
  const anchor = laidOut[to];
  if (!carried || !anchor) return null;
  // The STORED reference, never the laid-out one. A card is drawn from a `SessionSummary`, which
  // satisfies this shape and carries a title, timestamps and capabilities besides -- and all of it
  // would go on the wire from here. The same rebuild `detachBotSession` makes, for the same reason.
  const moved = refs.find((ref) => sessionKey(ref) === sessionKey(carried));
  if (!moved) return null;
  const rest = refs.filter((ref) => sessionKey(ref) !== sessionKey(moved));
  const at = rest.findIndex((ref) => sessionKey(ref) === sessionKey(anchor));
  if (at < 0) return null;
  const sessionRefs = [...rest];
  // Past the anchor when the carry went right, in front of it when it went left: a card dropped on
  // its neighbour takes that neighbour's place, which is the direction the strip drew it moving.
  sessionRefs.splice(to > from ? at + 1 : at, 0, moved);
  return { sessionRefs, moved };
}

/**
 * Cards the drag order has no place for -- a session still starting, a fork not yet sent -- put
 * beside the laid-out card each stands after in the Bot's order, keyed by that card's session key.
 *
 * The Bot's order is the one answer to where a card goes: the sidecar stands a fork right after
 * its source, so the starting card is drawn there too, and does not move when its first turn
 * turns it into an ordinary card. Within one card's group they keep the Bot's order. One the order
 * does not hold yet, or that has no laid-out card before it, is under `null`: the end of the row,
 * after the ones that are placed.
 */
export function standingAfter<T>(
  refs: readonly BotSessionRef[],
  laidOut: readonly BotSessionRef[],
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string | null, T[]> {
  const shown = new Set(laidOut.map(sessionKey));
  const position = new Map(refs.map((ref, index) => [sessionKey(ref), index]));
  const groups = new Map<string | null, T[]>();
  const ranked = [...items].sort((a, b) => (position.get(keyOf(a)) ?? Infinity) - (position.get(keyOf(b)) ?? Infinity));
  for (const item of ranked) {
    const at = position.get(keyOf(item));
    let after: string | null = null;
    for (let index = (at ?? 0) - 1; at !== undefined && index >= 0; index -= 1) {
      const key = sessionKey(refs[index]!);
      if (shown.has(key)) {
        after = key;
        break;
      }
    }
    groups.set(after, [...(groups.get(after) ?? []), item]);
  }
  return groups;
}
