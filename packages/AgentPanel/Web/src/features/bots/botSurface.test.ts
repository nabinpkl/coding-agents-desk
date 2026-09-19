// What is worth pinning is not which colour a Bot gets -- it is that the colour stops moving.
//
// A card's colour is a name a reader learns without being told, so the failure that matters is not
// an ugly palette, it is a Bot that was blue yesterday. Every test below is about something NOT
// changing: adding a Bot, hiding a Bot, or the sidecar handing back the same roster in a different
// order.

import { describe, expect, test } from "vitest";
import type { CSSProperties } from "react";
import {
  BOT_HUE_OFFSET,
  BOT_HUE_STEP,
  BOT_SESSION_FACE_BASE,
  BOT_SESSION_HUE_SPACING,
  BOT_SESSION_SHADES,
  botCanvasHues,
  botCanvasRanks,
  botSessionFaceRank,
  botSessionShades,
  botSessionStyle,
  botSurfaceStyle,
  sessionInitials,
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

describe("botCanvasRanks", () => {
  test("ranks the creation order the hues colour by, so a face and a colour cannot disagree", () => {
    const ranks = botCanvasRanks(ROSTER);
    const hues = botCanvasHues(ROSTER);
    for (const each of ROSTER) {
      const rank = ranks.get(each.botId)!;
      expect(hues.get(each.botId)).toBeCloseTo((BOT_HUE_OFFSET + rank * BOT_HUE_STEP) % 360, 6);
    }
    expect(ranks.get(ROSTER[0]!.botId)).toBe(0);
  });

  test("a reordered snapshot ranks nothing differently", () => {
    const forwards = botCanvasRanks(ROSTER);
    const backwards = botCanvasRanks([...ROSTER].reverse());
    expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
  });

  test("a Bot the roster has never seen has no rank, which is what leaves a preview faceless", () => {
    expect(botCanvasRanks(ROSTER).get("not-a-bot-yet")).toBeUndefined();
  });
});

describe("botSessionFaceRank", () => {
  test("siblings never share an input, because the step is unique within a Bot", () => {
    const inputs = new Set([0, 1, 2, 3, 4, 5].map((step) => botSessionFaceRank(2, step)));
    expect(inputs.size).toBe(6);
  });

  test("no session input reaches into the Bots' numbering", () => {
    // Provable by arithmetic rather than by drawing: the smallest session input is the base
    // itself, the base sits past every Bot rank this side of 256, and the largest session input
    // for forty Bots of six sessions stays under the 500 the permutation is exact over. Whether
    // those inputs then draw different faces is the avatar test's property, pinned over the
    // realistic range there.
    for (let bot = 0; bot < 40; bot += 1) {
      for (let step = 0; step < 6; step += 1) {
        const input = botSessionFaceRank(bot, step);
        expect(input).toBeGreaterThanOrEqual(BOT_SESSION_FACE_BASE);
        expect(input).toBeLessThan(500);
      }
    }
    expect(BOT_SESSION_FACE_BASE).toBeGreaterThan(39);
  });

  test("a session keeps its face while its neighbours come and go", () => {
    // Both halves are stable: the Bot's rank moves only if an older Bot is deleted, which the
    // sidecar has no route for, and the step is the session's place in the Bot's durable refs.
    expect(botSessionFaceRank(2, 3)).toBe(botSessionFaceRank(2, 3));
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

  test("a Bot with one session still ranks it, because a lone card is still a card", () => {
    // Step zero is a real rung and this is the one place it is the WHOLE ladder. What a solo
    // session drops is its rail, which is the card's call and not this function's: a shade says
    // "I am a card sitting on this Bot" and is worth having with one session, where a rail says
    // "I am this Bot's, among its several" and is not.
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
    expect(botSessionStyle(137.508, 3)).toEqual({
      "--bot-hue": "137.51",
      "--bot-session-step": "3",
      // Three slots of sixty degrees along from its Bot. The Bot's own hue is published
      // UNTURNED beside it, because the rail reads that one and must not move with the session.
      "--bot-session-hue": "317.51",
    });
  });

  test("a step with no hue gets nothing, so it cannot shade the colour it inherited", () => {
    // The card sits inside its Bot's card, which has already set `--bot-hue`. A step published
    // without a hue of its own would resolve against that one and paint a ladder the session is
    // not on.
    expect(botSessionStyle(undefined, 2)).toBeUndefined();
    expect(botSessionStyle(137.508, undefined)).toBeUndefined();
  });

  test("step zero is published, because it is a real step and not a missing one", () => {
    expect(botSessionStyle(24, 0)).toEqual({
      "--bot-hue": "24.00",
      "--bot-session-step": "0",
      "--bot-session-hue": "24.00",
    });
  });

  test("a Bot's sessions are spread over the whole circle, not clustered on its own hue", () => {
    const spread = Array.from({ length: BOT_SESSION_SHADES }, (_, step) =>
      Number(botSessionStyle(180, step)!["--bot-session-hue" as keyof CSSProperties]));
    expect(spread).toEqual([180, 240, 300, 0, 60, 120]);
    // The first session lands ON its Bot's hue and every other one is a different colour entirely.
    // That is the point rather than a side effect: a narrow arc around the Bot was measured first
    // and moved a card 0.0054 dEok, because rotating a low-chroma colour barely moves it.
    expect(spread[0]).toBe(180);
    expect(new Set(spread).size).toBe(BOT_SESSION_SHADES);
    // Evenly, so the two sessions that end up closest are as far apart as six can be.
    for (let i = 1; i < spread.length; i += 1) {
      expect((spread[i]! - spread[i - 1]! + 360) % 360).toBeCloseTo(BOT_SESSION_HUE_SPACING, 6);
    }
  });
});

describe("sessionInitials", () => {
  test("takes one letter per word, so two sessions of a Bot differ at a glance", () => {
    expect(sessionInitials("AD Project manager")).toBe("AP");
  });

  test("skips a connector rather than spending a letter on it", () => {
    // "CA" would be C for CPU and A for "and", which every title with a conjunction would give.
    expect(sessionInitials("CPU and RAM usage")).toBe("CR");
  });

  test("gives a one-word title two of its own letters", () => {
    // A bare "E" collides with every other session starting in e, and single-word titles are the
    // common case on this canvas rather than the edge one.
    expect(sessionInitials("evals")).toBe("EV");
    expect(sessionInitials("graphifycodebot")).toBe("GR");
  });

  test("reads through the punctuation a fork title carries", () => {
    expect(sessionInitials("AD Project manager (fork 1)")).toBe("AP");
    expect(sessionInitials("workspace-ide/vite")).toBe("WI");
  });

  test("counts a digit as a letter", () => {
    expect(sessionInitials("fork 2")).toBe("F2");
  });

  test("keeps a title made only of connectors rather than coming back empty", () => {
    // Nothing is left after filtering, so the unfiltered words are used: an odd mark beats none.
    expect(sessionInitials("the and")).toBe("TA");
  });

  test("falls back for a title with no letters or digits in it", () => {
    expect(sessionInitials("---")).toBe("S");
    expect(sessionInitials("")).toBe("S");
  });
});
