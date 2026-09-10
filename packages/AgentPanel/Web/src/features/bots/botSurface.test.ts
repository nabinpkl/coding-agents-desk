// What is worth pinning is not which colour a Bot gets -- it is that the colour stops moving.
//
// A card's colour is a name a reader learns without being told, so the failure that matters is not
// an ugly palette, it is a Bot that was blue yesterday. Every test below is about something NOT
// changing: adding a Bot, hiding a Bot, or the sidecar handing back the same roster in a different
// order.

import { describe, expect, test } from "vitest";
import {
  BOT_HUE_OFFSET,
  BOT_HUE_STEP,
  BOT_SESSION_SHADES,
  botCanvasHues,
  botSessionShades,
  botSessionStyle,
  botSurfaceStyle,
} from "@/features/bots/botSurface";

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

describe("the palette reaches every surface from one derivation", () => {
  test("a Bot taken off the canvas keeps the face it had, because the sidebar still ranks it", () => {
    // The sidebar derives its own map rather than being handed one, and this is the property that
    // makes that safe: it renders the Bots that are OFF the canvas too, so its input is the whole
    // roster -- the same input the shell gives the canvas. A Bot detached from the canvas is dimmed
    // in this list, not recoloured, and its card comes back wearing the colour it left with.
    const detached = ROSTER[1]!;
    const hues = botCanvasHues(ROSTER);
    expect(hues.get(detached.botId)).toBeCloseTo((BOT_HUE_OFFSET + BOT_HUE_STEP) % 360, 6);
    // Whereas a panel that only knew the Bots still on the canvas would have no colour for it.
    const onlyWhatTheCanvasShows = botCanvasHues(ROSTER.filter((each) => each !== detached));
    expect(onlyWhatTheCanvasShows.get(detached.botId)).toBeUndefined();
  });

  test("a Bot the roster has never seen has no hue, which is what leaves a preview neutral", () => {
    // The Bot creator draws a live avatar for a Bot that does not exist. Ranking it would be a
    // promise about which colour it is going to get.
    expect(botCanvasHues(ROSTER).get("not-a-bot-yet")).toBeUndefined();
    expect(botSurfaceStyle(botCanvasHues(ROSTER).get("not-a-bot-yet"))).toBeUndefined();
  });
});

const ref = (sessionId: string, source = "claude") => ({ source, sessionId });

/** One Bot's curated references, in the order it attached them. */
const REFS = [
  ref("6b1f0d4a-1f6d-4d3f-9d5f-0f7c1a2b3c4d"),
  ref("7c2a1e5b-2a7e-4e40-8e60-1a8d2b3c4d5e"),
  ref("8d3b2f6c-3b8f-4f51-9f71-2b9e3c4d5e6f", "codex"),
  ref("9e4c3a7d-4c90-4062-a082-3caf4d5e6f70"),
];

describe("botSessionShades", () => {
  test("gives each of a Bot's sessions its own step, so two of them never look alike", () => {
    const shades = botSessionShades(REFS);
    expect([...shades.values()]).toEqual([0, 1, 2, 3]);
    // Keyed the way every other part of the canvas addresses a session, source included: two
    // providers can hand back the same id and they are not the same session.
    expect(shades.get(`codex:${REFS[2]!.sessionId}`)).toBe(2);
    expect(shades.get(`claude:${REFS[2]!.sessionId}`)).toBeUndefined();
  });

  test("the first session is its Bot's own colour, so a Bot with one spends no colour on it", () => {
    expect(botSessionShades([REFS[0]!]).get(`claude:${REFS[0]!.sessionId}`)).toBe(0);
  });

  test("attaching a session recolours none of the ones already there", () => {
    const before = botSessionShades(REFS);
    const after = botSessionShades([...REFS, ref("af5d4b8e-5da1-4173-b193-4dbf5e6f7081")]);
    for (const [key, shade] of before) expect(after.get(key)).toBe(shade);
  });

  test("a session missing from the catalog still holds its rank", () => {
    // `sessionRefs` is the durable list and `sessions` is what resolved. Ranking the resolved list
    // would hand a forgotten session's shade to whoever came after it, and give it back when the
    // catalog remembered -- a card that changes colour because an unrelated transcript reappeared.
    const resolvedOnly = REFS.filter((each) => each !== REFS[1]);
    expect(botSessionShades(REFS).get(`claude:${REFS[3]!.sessionId}`)).toBe(3);
    expect(botSessionShades(resolvedOnly).get(`claude:${REFS[3]!.sessionId}`)).toBe(2);
  });

  test("past the last step it cycles, so neighbours differ however many sessions a Bot has", () => {
    const many = Array.from({ length: BOT_SESSION_SHADES * 2 + 1 }, (_, i) => ref(`s${i}`));
    const shades = [...botSessionShades(many).values()];
    expect(shades).toHaveLength(BOT_SESSION_SHADES * 2 + 1);
    // The property that matters is adjacency: a collision is allowed only between sessions a whole
    // ladder apart, which on a strip of cards is a different part of the screen.
    for (let i = 1; i < shades.length; i += 1) expect(shades[i]).not.toBe(shades[i - 1]);
    expect(shades[BOT_SESSION_SHADES]).toBe(shades[0]);
  });

  test("a Bot with no sessions has no shades rather than an empty first step", () => {
    expect(botSessionShades([]).size).toBe(0);
  });
});

describe("botSessionStyle", () => {
  test("hands CSS the Bot's hue and the session's step, and lets the theme own the rest", () => {
    expect(botSessionStyle(137.508, 3)).toEqual({ "--bot-hue": "137.51", "--bot-session-step": "3" });
  });

  test("a step with no hue gets nothing, so it cannot shade the colour it inherited", () => {
    // The card sits inside its Bot's card, which has already set `--bot-hue`. A step published
    // without a hue of its own would resolve against that one and paint a ladder the session is
    // not on.
    expect(botSessionStyle(undefined, 2)).toBeUndefined();
    expect(botSessionStyle(137.508, undefined)).toBeUndefined();
  });

  test("step zero is published, because it is a real step and not a missing one", () => {
    expect(botSessionStyle(24, 0)).toEqual({ "--bot-hue": "24.00", "--bot-session-step": "0" });
  });
});
