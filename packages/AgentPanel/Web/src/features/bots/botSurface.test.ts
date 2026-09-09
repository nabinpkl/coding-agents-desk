// What is worth pinning is not which colour a Bot gets -- it is that the colour stops moving.
//
// A card's colour is a name a reader learns without being told, so the failure that matters is not
// an ugly palette, it is a Bot that was blue yesterday. Every test below is about something NOT
// changing: adding a Bot, hiding a Bot, or the sidecar handing back the same roster in a different
// order.

import { describe, expect, test } from "vitest";
import { BOT_HUE_OFFSET, BOT_HUE_STEP, botCanvasHues, botSurfaceStyle } from "./botSurface";

const bot = (botId: string, createdAt: number) => ({ botId, createdAt });

/** The six on this canvas, with their real creation order. */
const ROSTER = [
  bot("75ab9971-98c7-4b4a-9f4c-38eab2ebcda4", 1787782165758),
  bot("0da14175-d2ee-44f9-be2e-f8644e43093c", 1787787203313),
  bot("1d96c0f7-ad16-4097-95a8-8cfd049d7790", 1787791616485),
  bot("3dd41d3a-cc11-43d3-b59f-7a85c0a6d04d", 1787859227749),
  bot("884fd27e-0be5-4ea4-84e5-b0647c792d4b", 1788928495915),
  bot("da1d69a4-9167-41be-a3bb-c5277550e0cc", 1788932296357),
];

/** The smallest gap between any two hues, going round the circle rather than along a line. */
function closestPair(hues: number[]): number {
  const sorted = [...hues].sort((a, b) => a - b);
  let closest = 360;
  for (let i = 0; i < sorted.length; i += 1) {
    const gap = i === 0 ? sorted[0]! + 360 - sorted.at(-1)! : sorted[i]! - sorted[i - 1]!;
    closest = Math.min(closest, gap);
  }
  return closest;
}

describe("botCanvasHues", () => {
  test("orders by creation, not by the order the roster arrived in", () => {
    // The sidecar's array order is not a promise. Ranking on it would give a Bot a new colour on
    // whichever snapshot happened to serialise the roster differently.
    const forwards = botCanvasHues(ROSTER);
    const backwards = botCanvasHues([...ROSTER].reverse());
    expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
    expect(forwards.get(ROSTER[0]!.botId)).toBe(BOT_HUE_OFFSET);
  });

  test("a new Bot takes the next colour and leaves every other one alone", () => {
    const before = botCanvasHues(ROSTER);
    const after = botCanvasHues([...ROSTER, bot("new-bot", 1788999999999)]);
    for (const each of ROSTER) expect(after.get(each.botId)).toBe(before.get(each.botId));
    expect(after.get("new-bot")).toBeCloseTo((BOT_HUE_OFFSET + 6 * BOT_HUE_STEP) % 360, 6);
  });

  test("hiding a Bot from the canvas cannot recolour the rest, because ranks come from the roster", () => {
    // The reason this map is built in the shell rather than in `BotCanvas`: the canvas is handed
    // the Bots it shows, and a rank over that subset would repaint the strip on every detach.
    const whole = botCanvasHues(ROSTER);
    const shown = ROSTER.filter((each) => each.botId !== ROSTER[2]!.botId);
    // Each remaining Bot still sits at the index it has in the ROSTER, third one included in the
    // count, so hiding one leaves a gap in the wheel rather than closing it.
    for (const each of shown) {
      const rank = ROSTER.indexOf(each);
      expect(whole.get(each.botId)).toBeCloseTo((BOT_HUE_OFFSET + rank * BOT_HUE_STEP) % 360, 6);
    }
    // Ranking the visible subset instead is what we are NOT doing, and this is what it would cost:
    // every Bot after the hidden one takes a different colour.
    const ifRankedOnTheSubset = botCanvasHues(shown);
    const moved = shown.filter((each) => ifRankedOnTheSubset.get(each.botId) !== whole.get(each.botId));
    expect(moved.map((each) => each.botId)).toEqual(ROSTER.slice(3).map((each) => each.botId));
  });

  test("two Bots created in the same millisecond get a stable order, not the array's", () => {
    const tie = [bot("bbb", 500), bot("aaa", 500)];
    expect(botCanvasHues(tie).get("aaa")).toBe(BOT_HUE_OFFSET);
    expect(botCanvasHues([...tie].reverse()).get("aaa")).toBe(BOT_HUE_OFFSET);
  });

  test("the six on this canvas are far apart, which hashing their ids was measured not to be", () => {
    // Hashing an id straight to a hue put two of these six on the same degree and two more one
    // degree apart. Spacing by rank makes the gap arithmetic instead of luck.
    const hues = [...botCanvasHues(ROSTER).values()];
    expect(new Set(hues).size).toBe(6);
    expect(closestPair(hues)).toBeGreaterThan(20);
  });

  test("stays well spread at twelve, so the guarantee is not tuned to today's roster", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`bot-${i}`, 1000 + i));
    const hues = [...botCanvasHues(many).values()];
    expect(new Set(hues.map((hue) => Math.round(hue))).size).toBe(12);
    expect(closestPair(hues)).toBeGreaterThan(10);
    for (const hue of hues) expect(hue).toBeGreaterThanOrEqual(0);
    for (const hue of hues) expect(hue).toBeLessThan(360);
  });

  test("an empty roster is an empty map rather than a throw", () => {
    expect(botCanvasHues([]).size).toBe(0);
  });
});

describe("botSurfaceStyle", () => {
  test("hands CSS the hue and nothing else, so the theme owns lightness and chroma", () => {
    expect(botSurfaceStyle(137.508)).toEqual({ "--bot-hue": "137.51" });
  });

  test("a Bot with no hue gets no properties, so its card stays the plain one it was", () => {
    // Not hue zero: a card the roster has not ranked should look untouched rather than red.
    expect(botSurfaceStyle(undefined)).toBeUndefined();
  });
});
