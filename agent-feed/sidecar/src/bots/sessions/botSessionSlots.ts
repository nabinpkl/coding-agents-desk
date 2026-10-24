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
//
// Numbers may be skipped, though. The panel paints a card's hue from its slot round
// `BOT_SESSION_HUE_COUNT`, so two slots that far apart paint alike, and a fork stands beside its
// source with whatever number the counter had reached: Alan held 1, his fork Ethan took 33, and the
// two cards side by side were one colour (2026-10-19). A new session therefore takes the first
// number at or past the counter that paints unlike the sessions it stands between. Cards a reader
// drags together, and a reattach restoring its old number, can still match; nothing here moves a
// slot once spent to stop that.

import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import { BOT_SESSION_HUE_COUNT } from "@agentdesk/agent-feed-wire";
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

/** The first slot at or past `from` that paints unlike every one of `beside`. */
function slotApart(from: number, beside: readonly number[]): number {
  const taken = new Set(beside.map((slot) => slot % BOT_SESSION_HUE_COUNT));
  // There are at most two neighbours and more hues than that, so this ends within three numbers.
  let slot = from;
  while (taken.has(slot % BOT_SESSION_HUE_COUNT)) slot += 1;
  return slot;
}

/**
 * Every held reference holds a slot afterwards, in the Bot's own order.
 *
 * Called with the FULL held list after every attach, so a record that predates slots backfills
 * from the order its sessions already wear, a reattach finds its old entry and restores it, and
 * only a never-before-attached session takes the next number that paints unlike its neighbours
 * in `refs`. So `refs` is the order the cards will stand in, the newcomer already placed. Detach
 * and reorder never call this, which is the whole point: there is no path that moves a slot once
 * spent.
 */
export function ensureSessionSlots(
  record: Pick<BotRecord, "sessionSlots" | "nextSessionSlot">,
  refs: readonly BotSessionRef[],
): { sessionSlots: Record<string, number>; nextSessionSlot: number } {
  const sessionSlots: Record<string, number> = { ...(record.sessionSlots ?? {}) };
  let next = record.nextSessionSlot ?? 0;
  refs.forEach((ref, index) => {
    const key = sessionKey(ref);
    if (sessionSlots[key] !== undefined) return;
    // A neighbour that is itself new and not yet numbered is skipped: it compares against this one
    // when its own turn comes.
    const beside = [refs[index - 1], refs[index + 1]].flatMap((near) => {
      const slot = near === undefined ? undefined : sessionSlots[sessionKey(near)];
      return slot === undefined ? [] : [slot];
    });
    sessionSlots[key] = slotApart(next, beside);
    next = sessionSlots[key] + 1;
  });
  // A pre-slots record carries no counter, so it starts wherever its backfill left off.
  if (record.nextSessionSlot === undefined) {
    next = Object.values(sessionSlots).reduce((high, slot) => Math.max(high, slot), -1) + 1;
  }
  return { sessionSlots, nextSessionSlot: next };
}
