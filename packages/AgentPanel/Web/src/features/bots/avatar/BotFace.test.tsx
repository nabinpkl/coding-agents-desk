// What is worth pinning is that a face is a NAME: it must not move, and two Bots must not share it.
//
// The drawing itself is a taste question and belongs in a browser. What belongs here is the
// uniqueness under it, because both of its failures are silent -- a face that changes when the
// roster grows teaches a reader a name and then takes it away, and two Bots with one face teach
// them nothing at all. There is no catalogue and no cycle any more: every rank draws its own
// face, so these tests count faces rather than cycle positions.

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { BOT_FACE_PAIRS, BotFace, botFaceOf } from "@/features/bots/avatar/BotFace";
import { BOT_SESSION_FACE_BASE, botSessionFaceRank } from "@/features/bots/botSurface";

const key = (rank: number): string => {
  const face = botFaceOf(rank);
  return `${face.head}|${face.eyes.map((e) => `${e.cx}:${e.rx}:${e.ry}`).join(",")}`;
};

/**
 * Every face a large panel draws: forty Bots, and six sessions each for all of them. Every input
 * sits under 500, so the permutation owes each of these its own pair -- if any two shared a
 * drawing the numbering promise would already be broken where it matters.
 */
function realisticRanks(): number[] {
  const ranks: number[] = [];
  for (let bot = 0; bot < 40; bot += 1) ranks.push(bot);
  for (let bot = 0; bot < 40; bot += 1) {
    for (let step = 0; step < 6; step += 1) ranks.push(botSessionFaceRank(bot, step));
  }
  return ranks;
}

describe("botFaceOf", () => {
  test("every face a realistic panel draws is a different drawing", () => {
    const ranks = realisticRanks();
    expect(new Set(ranks.map(key)).size).toBe(ranks.length);
  });

  test("the set behind the permutation is a hundred distinct polygons", () => {
    // 37 is coprime to 500, so the first five hundred ranks reach every pair: every head in the
    // frozen set is drawn by some rank, and no two of them are the same string.
    const heads = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) heads.add(botFaceOf(rank).head);
    expect(heads.size).toBe(100);
  });

  test("no session input reaches a Bot's drawing", () => {
    // The sessions number from their own base, and the permutation is exact: what is pinned here
    // is the numbering, which is what keeps the two apart before a single path is drawn.
    for (let bot = 0; bot < 40; bot += 1) {
      expect(botSessionFaceRank(bot, 0)).toBeGreaterThanOrEqual(BOT_SESSION_FACE_BASE);
      expect(botSessionFaceRank(bot, 5)).toBeLessThan(BOT_FACE_PAIRS);
    }
    expect(BOT_SESSION_FACE_BASE).toBeGreaterThan(39);
  });

  test("every head stays inside the box it is drawn in", () => {
    // A spoke past the viewport is clipped silently, which reads as a head with its edge sliced
    // off. Sweep the realistic range plus deep ranks. Anchors are fitted to 2..30; curve controls
    // may lean slightly past an anchor they bend toward, so the bound here is the viewport with
    // a margin rather than the fitting box.
    const ranks = realisticRanks();
    for (let extra = 0; extra < 2000; extra += 1) ranks.push(extra * 37);
    for (const rank of ranks) {
      const numbers = botFaceOf(rank).head.match(/-?\d+(\.\d+)?/g) ?? [];
      expect(numbers.length).toBeGreaterThan(0);
      for (const raw of numbers) {
        const n = Number(raw);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(31);
      }
    }
  });

  test("a face is the same face on every call", () => {
    expect(botFaceOf(6)).toEqual(botFaceOf(6));
  });

  test("a rank no roster can produce still draws a face", () => {
    expect(botFaceOf(-3).head).toBe(botFaceOf(3).head);
    expect(botFaceOf(2.7).head).toBe(botFaceOf(2).head);
    expect(botFaceOf(Number.NaN).head).toBe(botFaceOf(0).head);
  });
});

describe("BotFace", () => {
  test("open eyes blink and shut eyes do not", () => {
    const { container, rerender } = render(<BotFace rank={2} />);
    const eyes = container.querySelector<SVGGElement>(".bot-face-eyes")!;
    expect(eyes.className.baseVal).toContain("bot-face-eyes--open");
    rerender(<BotFace rank={2} shut />);
    expect(container.querySelector<SVGGElement>(".bot-face-eyes")!.className.baseVal)
      .toContain("bot-face-eyes--shut");
  });

  test("two Bots on one screen do not blink together", () => {
    const { container } = render(
      <>
        <BotFace rank={1} />
        <BotFace rank={2} />
      </>,
    );
    const [first, second] = [...container.querySelectorAll<SVGGElement>(".bot-face-eyes")];
    expect(first!.style.getPropertyValue("--bot-face-blink-delay"))
      .not.toBe(second!.style.getPropertyValue("--bot-face-blink-delay"));
  });

  test("the face says nothing to a screen reader, because the row already does", () => {
    render(<BotFace rank={0} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
