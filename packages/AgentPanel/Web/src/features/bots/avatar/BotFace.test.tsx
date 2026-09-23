// What is worth pinning is that a face is a NAME: it must not move, and two Bots must not share it.
//
// The drawing itself is a taste question and belongs in a browser. What belongs here is the
// uniqueness under it, because both of its failures are silent -- a face that changes when the
// roster grows teaches a reader a name and then takes it away, and two Bots with one face teach
// them nothing at all. There is no catalogue and no cycle any more: every rank draws its own
// face, so these tests count faces rather than cycle positions.

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  BOT_FACE_PAIRS, BotFace, botFaceOf, eyePath, shutEyePath,
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
  test("every face a realistic panel draws is a different drawing", () => {
    const ranks = realisticRanks();
    expect(new Set(ranks.map(key)).size).toBe(ranks.length);
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
 * What an eye's outline has to keep doing, now that it carries the face's whole expression.
 *
 * The drawing is a taste question and was settled in a browser. Three things under it are not, and
 * each fails silently. A lid that stops riding up puts the open set back to the flat-bottomed holes
 * a reader called sad. A shut lid that stops arching puts the resting roster -- which is most of
 * it -- back to a column of bars. And the two forms have to stay ONE drawing, command for command,
 * or `styles.css` cannot transition between them and a fold swaps the eyes instead of closing them.
 */
describe("eyePath", () => {
  const eyeOf = (rank: number) => botFaceOf(rank).eyes[0]!;
  /** The lid's control point, which is the last pair before the path closes. */
  const bellyOf = (path: string) => Number(/C[\d.]+ (-?[\d.]+) /.exec(path)![1]);
  const commandsOf = (path: string) => path.replace(/[^MLQCZ]/g, "");

  test("the open lid rides up, and the shut one arches through the eye line", () => {
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      // Below the eye line but well short of a full half-height: an open eye, lifted.
      expect(bellyOf(eyePath(eye))).toBeGreaterThan(eye.cy);
      expect(bellyOf(eyePath(eye))).toBeLessThan(eye.cy + eye.ry);
      // Above it: a closed lid, which is the whole difference between contented and switched off.
      expect(bellyOf(shutEyePath(eye))).toBeLessThan(eye.cy);
    }
  });

  test("the open eye still reaches its own top and its own width", () => {
    // The lift is the BOTTOM lid's. An eye that lost its height or its width would be a different
    // eye, and the shapes are what say which session this is.
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const points = pointsOf(eyePath(eye));
      expect(Math.min(...points.map(([, y]) => y))).toBeCloseTo(eye.cy - eye.ry, 5);
      expect(Math.min(...points.map(([x]) => x))).toBeCloseTo(eye.cx - eye.rx, 5);
      expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(eye.cx + eye.rx, 5);
    }
  });

  test("a shut eye is plainly thinner than the open one, on the same stations", () => {
    // Shut has to read as shut rather than as a squint, and it must not move: same width, same
    // centre, a lower ceiling.
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      const openTop = Math.min(...pointsOf(eyePath(eye)).map(([, y]) => y));
      const shutPoints = pointsOf(shutEyePath(eye));
      expect(Math.min(...shutPoints.map(([, y]) => y))).toBeGreaterThan(openTop);
      expect(Math.min(...shutPoints.map(([x]) => x))).toBeCloseTo(eye.cx - eye.rx, 5);
      expect(Math.max(...shutPoints.map(([x]) => x))).toBeCloseTo(eye.cx + eye.rx, 5);
    }
  });

  test("the two forms are the same path, so the lid can be transitioned closed", () => {
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const eye = eyeOf(rank);
      expect(commandsOf(shutEyePath(eye))).toBe(commandsOf(eyePath(eye)));
      expect(pointsOf(shutEyePath(eye)).length).toBe(pointsOf(eyePath(eye)).length);
    }
  });

  test("one head still wears five different eyes", () => {
    // Asked PER HEAD, because an eye's width now comes from the head's span as well as its own
    // shape: two heads sharing a span draw the same eye, and that is the point rather than a
    // collision. What must not collapse is the five shapes ON ONE HEAD, which is the channel that
    // says which session this is once the head has said whose.
    const perHead = new Map<string, Set<string>>();
    for (let rank = 0; rank < BOT_FACE_PAIRS; rank += 1) {
      const face = botFaceOf(rank);
      const shapes = perHead.get(face.head) ?? new Set<string>();
      shapes.add(eyePath({ ...face.eyes[0]!, cx: 16 }));
      perHead.set(face.head, shapes);
    }
    expect(perHead.size).toBe(25);
    for (const shapes of perHead.values()) expect(shapes.size).toBe(5);
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
    const socket = "path[fill='var(--bot-face-socket)']";
    const path = () => container.querySelector(socket)!.getAttribute("d");
    expect(path()).toBe(eyePath(eye));
    rerender(<BotFace rank={2} shut />);
    expect(path()).toBe(shutEyePath(eye));
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
