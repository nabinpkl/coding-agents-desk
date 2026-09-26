// A slot is spent once and never moves: attach assigns, reorder ignores, detach keeps,
// reattach restores.

import { expect, test } from "bun:test";
import { ensureSessionSlots, slotsOf } from "@/bots/sessions/botSessionSlots";

const ref = (sessionId: string, source = "claude") => ({ source: source as "claude", sessionId });

test("a first attach spends slots in order, starting at zero", () => {
  const { sessionSlots, nextSessionSlot } = ensureSessionSlots({}, [ref("a"), ref("b")]);
  expect(sessionSlots).toEqual({ "claude:a": 0, "claude:b": 1 });
  expect(nextSessionSlot).toBe(2);
});

test("a later attach keeps every spent slot and spends only the newcomer", () => {
  const held = { sessionSlots: { "claude:a": 0, "claude:b": 1 }, nextSessionSlot: 2 };
  const { sessionSlots, nextSessionSlot } = ensureSessionSlots(held, [ref("a"), ref("b"), ref("c")]);
  expect(sessionSlots).toEqual({ "claude:a": 0, "claude:b": 1, "claude:c": 2 });
  expect(nextSessionSlot).toBe(3);
});

test("a reattach restores the slot detach kept, rather than spending a new one", () => {
  const held = { sessionSlots: { "claude:a": 0, "claude:b": 1 }, nextSessionSlot: 2 };
  const { sessionSlots, nextSessionSlot } = ensureSessionSlots(held, [ref("b"), ref("a")]);
  expect(sessionSlots).toEqual({ "claude:a": 0, "claude:b": 1 });
  expect(nextSessionSlot).toBe(2);
});

test("a pre-slots record backfills from the order its sessions already wear", () => {
  const { sessionSlots, nextSessionSlot } = ensureSessionSlots({}, [ref("a"), ref("b"), ref("c")]);
  expect(sessionSlots).toEqual({ "claude:a": 0, "claude:b": 1, "claude:c": 2 });
  expect(nextSessionSlot).toBe(3);
  // And the counter starts where that backfill left off, not at zero over it.
  const after = ensureSessionSlots({ sessionSlots, nextSessionSlot }, [ref("a"), ref("b"), ref("c"), ref("d")]);
  expect(after.sessionSlots["claude:d"]).toBe(3);
  expect(after.nextSessionSlot).toBe(4);
});

test("slotsOf reads the stored slot, falling back to position only before slots exist", () => {
  const record = {
    sessionRefs: [ref("a"), ref("b")],
    sessionSlots: { "claude:b": 5 },
  };
  const slots = slotsOf(record);
  expect(slots.get("claude:a")).toBe(0);
  expect(slots.get("claude:b")).toBe(5);
});
