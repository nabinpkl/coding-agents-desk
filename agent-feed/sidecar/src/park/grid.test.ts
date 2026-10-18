import { describe, expect, test } from "bun:test";
import { packFromTopLeft, usableArea } from "@/park/grid";

const DESK = { x: 1800, y: 40, w: 7680, h: 4280 };
const TERMINAL = { w: 860, h: 499 };

describe("packFromTopLeft", () => {
  test("puts neighbours one gap apart, not one region apart", () => {
    const [first, second] = packFromTopLeft(DESK, [TERMINAL, TERMINAL], 24);
    expect(first).toEqual({ x: 1824, y: 64, w: 860, h: 499 });
    // The whole point: 24pt between them, not the 1668pt an even three-column
    // division of a 7680pt display would leave.
    expect(second!.x - (first!.x + first!.w)).toBe(24);
    expect(second!.y).toBe(first!.y);
  });

  test("shares a top edge across a row and a left edge across rows", () => {
    const placed = packFromTopLeft(DESK, Array(12).fill(TERMINAL), 24);
    const firstRow = placed.filter((slot) => slot.y === placed[0]!.y);
    expect(firstRow.length).toBeGreaterThan(1);
    for (const slot of firstRow) expect(slot.y).toBe(placed[0]!.y);
    const wrapped = placed.find((slot) => slot.y !== placed[0]!.y);
    expect(wrapped?.x).toBe(placed[0]!.x);
  });

  test("wraps before crossing the right edge", () => {
    const placed = packFromTopLeft(DESK, Array(20).fill(TERMINAL), 24);
    for (const slot of placed) {
      expect(slot.x + slot.w).toBeLessThanOrEqual(DESK.x + DESK.w - 24);
    }
    expect(placed.some((slot) => slot.y !== placed[0]!.y)).toBe(true);
  });

  test("never overlaps", () => {
    const sizes = [TERMINAL, { w: 2526, h: 2104 }, TERMINAL, { w: 1024, h: 800 }, TERMINAL];
    const placed = packFromTopLeft(DESK, sizes, 24);
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        const one = placed[a]!;
        const two = placed[b]!;
        const disjoint =
          one.x + one.w <= two.x || two.x + two.w <= one.x || one.y + one.h <= two.y || two.y + two.h <= one.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  test("shrinks a window too big for the desk but never grows a small one", () => {
    const [big] = packFromTopLeft(DESK, [{ w: 99_999, h: 99_999 }], 24);
    expect(big).toEqual({ x: 1824, y: 64, w: 7632, h: 4232 });
    const [small] = packFromTopLeft(DESK, [TERMINAL], 24);
    expect(small!.w).toBe(TERMINAL.w);
    expect(small!.h).toBe(TERMINAL.h);
  });

  test("does not wrap a window that is the first in its row", () => {
    const placed = packFromTopLeft(DESK, [{ w: 7632, h: 400 }, TERMINAL], 24);
    expect(placed[0]!.y).toBe(64);
    expect(placed[1]!.y).toBeGreaterThan(placed[0]!.y);
    expect(placed[1]!.x).toBe(1824);
  });

  test("returns nothing for no windows, and rejects a negative gap", () => {
    expect(packFromTopLeft(DESK, [], 24)).toEqual([]);
    expect(() => packFromTopLeft(DESK, [TERMINAL], -1)).toThrow(RangeError);
    expect(() => packFromTopLeft({ x: 0, y: 0, w: 10, h: 10 }, [TERMINAL], 24)).toThrow(RangeError);
  });
});

describe("usableArea", () => {
  test("takes the menu bar off the top and nothing off the bottom", () => {
    expect(usableArea({ x: 1800, y: 0, w: 7680, h: 4320 }, 40)).toEqual({ x: 1800, y: 40, w: 7680, h: 4280 });
  });
});
