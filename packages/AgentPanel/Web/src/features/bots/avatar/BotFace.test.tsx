// What is worth pinning is that a face is a NAME: it must not move, and two Bots must not share it.
//
// The drawing itself is a taste question and belongs in a browser. What belongs here is the
// uniqueness under it, because both of its failures are silent -- a face that changes when the
// roster grows teaches a reader a name and then takes it away, and two Bots with one face teach
// them nothing at all. There is no catalogue and no cycle any more: every rank draws its own
// face, so these tests count faces rather than cycle positions.

import { describe, expect, test } from "vitest";

/** Twenty-five heads, so at most twenty-five eye sizes: one per head, and often shared. */
const HEADS_IN_SET = 25;
import { render, screen } from "@testing-library/react";
import {
  BOT_FACE_DRAWINGS, BOT_FACE_PAIRS, BotFace, botFaceOf, eyePath, pupilPath, shutEyePath,
} from "@/features/bots/avatar/BotFace";
import { BOT_SESSION_FACE_BASE, botSessionFaceRank } from "@/features/bots/botSurface";

/**
 * The points a head path actually visits, arcs included but their parameters excluded.
 *
 * Every head is written in absolute commands, which is what makes this readable at all: the
 * numbers in an `M`, `L`, `C` or `Q` are coordinate pairs, and in an `A` only the last two are.
 */
function pointsOf(path: string): [number, number][] {
  const points: [number, number][] = [];
  for (const [, letter, body] of path.matchAll(/([MLCQAZ])([^MLCQAZ]*)/g)) {
    const numbers = (body.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const pairs = letter === "A"
      ? numbers.slice(5).reduce<number[]>((all, n, i) => (i % 7 < 2 ? [...all, n] : all), numbers.slice(5, 7))
      : numbers;
    if (letter === "A") {
      for (let i = 5; i + 1 < numbers.length; i += 7) points.push([numbers[i]!, numbers[i + 1]!]);
      continue;
    }
    for (let i = 0; i + 1 < pairs.length; i += 2) points.push([pairs[i]!, pairs[i + 1]!]);
  }
  return points;
}

const key = (rank: number): string => {
  const face = botFaceOf(rank);
  return `${face.head}|${face.top.join("+")}|${face.eyes.map((e) => `${e.cx}:${e.rx}:${e.ry}`).join(",")}`;
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
  test("no two Bots share a face, and no two sessions of one Bot do", () => {
    // What a reader sees side by side. Faces repeat ACROSS families now that there is one eye
    // shape -- a hundred drawings against two hundred and eighty ranks -- and these two are the
    // pairs where a repeat would actually read as the same Bot twice.
    const bots = [...Array(40).keys()];
    expect(new Set(bots.map(key)).size).toBe(bots.length);
    for (const bot of bots) {
      const sessions = [...Array(6).keys()].map((step) => key(botSessionFaceRank(bot, step)));
      expect(new Set(sessions).size).toBe(sessions.length);
    }
  });

  test("the set holds a hundred drawings, which is the ceiling a roster shares", () => {
    // Stated rather than implied: past a hundred entries two of them wear one face, and the way
    // to raise it is more tops rather than more eyes.
    const drawn = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) drawn.add(key(rank));
    expect(drawn.size).toBe(BOT_FACE_DRAWINGS);
    expect(realisticRanks().length).toBeGreaterThan(BOT_FACE_DRAWINGS);
  });

  test("the set behind the permutation is twenty-five distinct polygons", () => {
    // 37 is coprime to 500, so the first five hundred ranks reach every face: every head in the
    // frozen set is drawn by some rank, and no two of them are the same string.
    const heads = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) heads.add(botFaceOf(rank).head);
    expect(heads.size).toBe(25);
  });

  test("every top is reached, and one of them is bare", () => {
    const tops = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) tops.add(botFaceOf(rank).top.join("+"));
    expect(tops.size).toBe(4);
    expect(tops.has("")).toBe(true);
  });

  test("no session input lands on a Bot's", () => {
    // The two number from different places, so a Bot and a session never ask the permutation the
    // same question. They can still come out with the same DRAWING, which the ceiling test above
    // is about; this one is only that the inputs stay disjoint.
    for (let bot = 0; bot < 40; bot += 1) {
      expect(botSessionFaceRank(bot, 0)).toBeGreaterThanOrEqual(BOT_SESSION_FACE_BASE);
      expect(botSessionFaceRank(bot, 5)).toBeLessThan(BOT_FACE_PAIRS);
    }
    expect(BOT_SESSION_FACE_BASE).toBeGreaterThan(39);
  });

  test("every head stays inside the box it is drawn in", () => {
    // A head past the viewport is clipped silently, which reads as an edge sliced off. Only the
    // POINTS are checked: an arc carries its radii, its rotation and two flags before its endpoint,
    // and reading those as coordinates is how a correct path fails a test. Whether an eye sits
    // inside its head is a different question and not one jsdom can answer -- it has no SVG
    // geometry -- so that one is settled against the real paths in a browser before they are
    // frozen here.
    // Every rank in the set, reduced to the heads they actually draw: the outlines are a frozen
    // twenty-five, so walking thousands of ranks re-reads the same strings and times the suite out.
    const heads = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) heads.add(botFaceOf(rank).head);
    for (const head of heads) {
      const points = pointsOf(head);
      expect(points.length).toBeGreaterThan(0);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(1);
        expect(x).toBeLessThanOrEqual(31);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(31);
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

/**
 * What an eye has to keep doing, now that one drawing carries every face.
 *
 * The shapes are a taste question and were settled in a browser. Four things under them are not,
 * and each fails silently. A white that stops being symmetric reads as rounded at one end and
 * drawn out at the other. A pupil that outgrows the white, or slides off its centre, stops being
 * a pupil and becomes a dark mark with a rim around it. A lid that thickens stops reading as
 * closed and starts reading as a band of ink. And the shut form has to stand where the open one
 * does, or a card folding looks like the eyes jumping rather than closing.
 */
describe("eyePath", () => {
  const eyeOf = (rank: number) => botFaceOf(rank).eyes[0]!;
  const extentOf = (path: string) => {
    const points = pointsOf(path);
    return {
      top: Math.min(...points.map(([, y]) => y)),
      bottom: Math.max(...points.map(([, y]) => y)),
      left: Math.min(...points.map(([x]) => x)),
      right: Math.max(...points.map(([x]) => x)),
    };
  };
  test("the white is symmetric about the eye line, top cap to bottom cap", () => {
    // Both caps are the same curve mirrored, so the outline reaches exactly as far below the eye
    // line as above it -- control points included, which makes this an assertion about the curves
    // rather than about their endpoints.
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const { top, bottom, left, right } = extentOf(eyePath(eye));
      expect(eye.cy - top).toBeCloseTo(bottom - eye.cy, 2);
      expect(left).toBeCloseTo(eye.cx - eye.rx, 2);
      expect(right).toBeCloseTo(eye.cx + eye.rx, 2);
    }
  });

  test("the pupil is a disc in the middle, and the white around it is the larger part", () => {
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const white = extentOf(eyePath(eye));
      const pupil = extentOf(pupilPath(eye));
      // In the middle: the pupil stands on the white's own centre in both directions, so no head
      // in the set ends up with an eye looking off to one side or down.
      expect((pupil.left + pupil.right) / 2).toBeCloseTo(eye.cx, 2);
      expect((pupil.top + pupil.bottom) / 2).toBeCloseTo(eye.cy, 2);
      // White left on every side of it. The extents here are the control-point hull rather than
      // the drawn curve, which is the stricter of the two to keep inside.
      expect(pupil.left).toBeGreaterThan(white.left);
      expect(pupil.right).toBeLessThan(white.right);
      expect(pupil.top).toBeGreaterThan(white.top);
      expect(pupil.bottom).toBeLessThan(white.bottom);
      // The white is MORE of the eye than the pupil is, which is the thing that makes it read as
      // an eye rather than as a dark mark with a rim. A capsule is a rectangle plus a circle of
      // its own half-width; the pupil is that circle at a fraction of the radius.
      const radius = (pupil.right - pupil.left) / 2;
      const whiteArea = 4 * eye.rx * (eye.ry - eye.rx) + Math.PI * eye.rx ** 2;
      expect(Math.PI * radius ** 2).toBeLessThan(whiteArea / 2);
    }
  });

  test("a shut eye is a level lid, centred on the eye line and far thinner than the eye", () => {
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const shut = extentOf(shutEyePath(eye));
      // Level: as far above the eye line as below it, so no head wears a lid that sits high or
      // low on one side of its own eye.
      expect(eye.cy - shut.top).toBeCloseTo(shut.bottom - eye.cy, 2);
      // Thin enough to be a lid rather than a band: a closed eye reads closed because almost all
      // of the open eye's height is gone, not because the shape changed.
      expect(shut.bottom - shut.top).toBeLessThan(eye.ry / 2);
    }
  });

  test("a shut eye stands on the white's own points, so folding closes rather than moves", () => {
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const open = extentOf(eyePath(eye));
      const shut = extentOf(shutEyePath(eye));
      // Within a third of a unit rather than exactly: these extents are the control-point hull,
      // and the lid's round ends are cubics whose controls sit a third of the cap radius past the
      // point the curve actually reaches. The drawn ends land on the white's sides.
      expect(Math.abs(shut.left - open.left)).toBeLessThan(0.34);
      expect(Math.abs(shut.right - open.right)).toBeLessThan(0.34);
    }
  });

  test("every face wears the one eye, sized by the head it sits in", () => {
    // One shape everywhere: what differs between two faces is the head and what stands on it, and
    // the eye only ever gives up width or height to the head it has to fit inside.
    const sizes = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const [left, right] = botFaceOf(rank).eyes;
      expect(botFaceOf(rank).eyes).toHaveLength(2);
      expect(left!.rx).toBe(right!.rx);
      expect(left!.ry).toBe(right!.ry);
      sizes.add(`${left!.rx}:${left!.ry}`);
    }
    expect(sizes.size).toBeLessThanOrEqual(HEADS_IN_SET);
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

  test("a shut face draws the closed lid rather than the open eye", () => {
    // The class alone used to be the whole difference, because closing was a transform. It is the
    // path now, so the class agreeing is not evidence that the eyes closed.
    const eye = botFaceOf(2).eyes[0]!;
    const { container, rerender } = render(<BotFace rank={2} />);
    const eyes = () => container.querySelector(".bot-face-eyes")!;
    const drawn = (fill: string) =>
      [...eyes().querySelectorAll(`path[fill='${fill}']`)].map((path) => path.getAttribute("d"));
    expect(drawn("var(--bot-face-white)")).toContain(eyePath(eye));
    expect(drawn("var(--bot-face-ink)")).toContain(pupilPath(eye));
    rerender(<BotFace rank={2} shut />);
    expect(drawn("var(--bot-face-ink)"))
      .toEqual([shutEyePath(eye), shutEyePath(botFaceOf(2).eyes[1]!)]);
    // No white is left: a shut eye is the lid, with nothing open under it.
    expect(drawn("var(--bot-face-white)")).toEqual([]);
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
