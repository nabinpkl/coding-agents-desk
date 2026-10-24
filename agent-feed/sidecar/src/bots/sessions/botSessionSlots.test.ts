// A slot is spent once and never moves: attach assigns, reorder ignores, detach keeps,
// reattach restores.

import { expect, test } from "bun:test";
import { BOT_SESSION_HUE_COUNT } from "@agentdesk/agent-feed-wire";
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

// The panel paints a card's hue from its slot round BOT_SESSION_HUE_COUNT. A fork stands beside its
// source, so a counter that has gone round a whole number of times since the source was numbered
// would hand the fork its source's colour: Alan held 1, his fork took 33, and the two cards side by
// side were one colour.
test("a session placed beside another skips the numbers that would paint like it", () => {
  const held = { sessionSlots: { "claude:alan": 1, "claude:esther": 32 }, nextSessionSlot: 33 };
  const placed = [ref("alan"), ref("ethan"), ref("esther")];
  const { sessionSlots, nextSessionSlot } = ensureSessionSlots(held, placed);
  // 33 paints like Alan's 1 and 32 like Esther's 32, so the fork takes 34, and the counter moves past it.
  expect(sessionSlots["claude:ethan"]).toBe(34);
  expect(nextSessionSlot).toBe(35);
  expect(sessionSlots["claude:ethan"]! % BOT_SESSION_HUE_COUNT).not.toBe(1);
});

test("a session at the end compares only against the one before it", () => {
  const held = { sessionSlots: { "claude:a": 0, "claude:b": 1 }, nextSessionSlot: 9 };
  const { sessionSlots } = ensureSessionSlots(held, [ref("a"), ref("b"), ref("c")]);
  expect(sessionSlots["claude:c"]).toBe(10);
});

test("several newcomers together each paint unlike the one beside them", () => {
  const held = { sessionSlots: { "claude:a": 0 }, nextSessionSlot: 8 };
  const placed = [ref("a"), ref("b"), ref("c"), ref("d")];
  const { sessionSlots } = ensureSessionSlots(held, placed);
  const hues = placed.map((one) => sessionSlots[`claude:${one.sessionId}`]! % BOT_SESSION_HUE_COUNT);
  for (let i = 1; i < hues.length; i += 1) expect(hues[i]).not.toBe(hues[i - 1]);
});
