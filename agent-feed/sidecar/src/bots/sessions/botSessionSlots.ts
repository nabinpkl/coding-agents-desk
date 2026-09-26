// One stored number per attached session, assigned once and never recomputed.
//
// The panel ranks a session's shade and face from this rather than from its position in
// `sessionRefs`, which is what makes a reorder a pure reorder: the order moves and nothing
// repaints. Detaching keeps the entry, so a reattach restores the same shade and face, and a
// forgotten session holds its place while it is missing. Slots are per Bot, so the same session
// on two Bots wears each Bot's own step.
//
// Never reused and never compacted. A freed number handed to a later session would let two eras
// of one Bot share an identity, and a map that only grows by one entry per attach is not the
// thing worth optimizing.

import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import { sessionKey } from "@/bots/botIdempotency";

/** What the panel ranks from, with the pre-slots order as the only fallback. */
export function slotsOf(record: Pick<BotRecord, "sessionRefs" | "sessionSlots">): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  record.sessionRefs.forEach((ref, index) => {
    const stored = record.sessionSlots?.[sessionKey(ref)];
    slots.set(sessionKey(ref), stored ?? index);
  });
  return slots;
}

/**
 * Every held reference holds a slot afterwards, in the Bot's own order.
 *
 * Called with the FULL held list after every attach, so a record that predates slots backfills
 * from the order its sessions already wear, a reattach finds its old entry and restores it, and
 * only a never-before-attached session takes the next number. Detach and reorder never call
 * this, which is the whole point: there is no path that moves a slot once spent.
 */
export function ensureSessionSlots(
  record: Pick<BotRecord, "sessionSlots" | "nextSessionSlot">,
  refs: readonly BotSessionRef[],
): { sessionSlots: Record<string, number>; nextSessionSlot: number } {
  const sessionSlots: Record<string, number> = { ...(record.sessionSlots ?? {}) };
  let next = record.nextSessionSlot ?? 0;
  for (const ref of refs) {
    const key = sessionKey(ref);
    if (sessionSlots[key] === undefined) {
      sessionSlots[key] = next;
      next += 1;
    }
  }
  // A pre-slots record carries no counter, so it starts wherever its backfill left off.
  if (record.nextSessionSlot === undefined) {
    next = Object.values(sessionSlots).reduce((high, slot) => Math.max(high, slot), -1) + 1;
  }
  return { sessionSlots, nextSessionSlot: next };
}
