import { describe, expect, test } from "bun:test";
import { gridSlots, usableArea } from "./grid.ts";

const EIGHT_K = { x: 1800, y: 0, w: 7680, h: 4320 };

describe("gridSlots", () => {
  test("fills the last row rather than leaving a hole", () => {
    const slots = gridSlots(EIGHT_K, 5, 24);
    expect(slots).toHaveLength(5);
    const topRow = slots.filter((slot) => slot.y === slots[0]!.y);
    const bottomRow = slots.filter((slot) => slot.y !== slots[0]!.y);
    expect(topRow).toHaveLength(3);
    expect(bottomRow).toHaveLength(2);
    // The two bottom slots are wider precisely because there are fewer of them.
    expect(bottomRow[0]!.w).toBeGreaterThan(topRow[0]!.w);
  });

  test("keeps every slot inside the area", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 9, 12]) {
      for (const slot of gridSlots(EIGHT_K, count, 24)) {
        expect(slot.x).toBeGreaterThanOrEqual(EIGHT_K.x);
        expect(slot.y).toBeGreaterThanOrEqual(EIGHT_K.y);
        expect(slot.x + slot.w).toBeLessThanOrEqual(EIGHT_K.x + EIGHT_K.w + 0.001);
        expect(slot.y + slot.h).toBeLessThanOrEqual(EIGHT_K.y + EIGHT_K.h + 0.001);
      }
    }
  });

  test("does not overlap slots", () => {
    const slots = gridSlots(EIGHT_K, 5, 24);
    for (let a = 0; a < slots.length; a += 1) {
      for (let b = a + 1; b < slots.length; b += 1) {
        const one = slots[a]!;
        const two = slots[b]!;
        const disjoint = one.x + one.w <= two.x + 0.001
          || two.x + two.w <= one.x + 0.001
          || one.y + one.h <= two.y + 0.001
          || two.y + two.h <= one.y + 0.001;
        expect(disjoint).toBe(true);
      }
    }
  });

  test("one window takes the whole area minus the gap", () => {
    const [only] = gridSlots(EIGHT_K, 1, 24);
    expect(only).toEqual({ x: 1824, y: 24, w: 7632, h: 4272 });
  });

  test("returns nothing for no windows", () => {
    expect(gridSlots(EIGHT_K, 0, 24)).toEqual([]);
  });

  test("throws rather than emitting a slot with no surface", () => {
    expect(() => gridSlots({ x: 0, y: 0, w: 100, h: 40 }, 9, 24)).toThrow(RangeError);
    expect(() => gridSlots(EIGHT_K, 4, -1)).toThrow(RangeError);
  });
});

describe("usableArea", () => {
  test("takes the menu bar off the top and nothing off the bottom", () => {
    expect(usableArea(EIGHT_K, 40)).toEqual({ x: 1800, y: 40, w: 7680, h: 4280 });
  });
});
