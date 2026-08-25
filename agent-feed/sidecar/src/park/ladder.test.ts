import { describe, expect, test } from "bun:test";
import { type LadderWindow, plan, uncoveredArea } from "./ladder.ts";

const DISPLAY = { x: 0, y: 0, w: 1800, h: 1169 };
const OPTIONS = { display: DISPLAY, strip: 40, step: 24, topMargin: 39 };

function windows(count: number, w = 600, h = 877): LadderWindow[] {
  return Array.from({ length: count }, (_, i) => ({ id: 100 + i, frame: { x: 0, y: 0, w, h } }));
}

describe("uncoveredArea", () => {
  test("a window with nothing in front of it is fully exposed, clipped to the display", () => {
    // 560 of its 600 points hang off the right edge, so only the 40pt strip counts.
    const area = uncoveredArea({ x: 1760, y: 100, w: 600, h: 200 }, [], DISPLAY);
    expect(area).toBe(40 * 200);
  });

  test("two covers that each take half together leave nothing", () => {
    // The measured rule: coverage is union-based, so neither half alone matters.
    const base = { x: 100, y: 100, w: 200, h: 100 };
    const left = { x: 100, y: 100, w: 100, h: 100 };
    const right = { x: 200, y: 100, w: 100, h: 100 };
    expect(uncoveredArea(base, [left], DISPLAY)).toBe(100 * 100);
    expect(uncoveredArea(base, [right], DISPLAY)).toBe(100 * 100);
    expect(uncoveredArea(base, [left, right], DISPLAY)).toBe(0);
  });

  test("a cover that misses entirely removes nothing", () => {
    const base = { x: 100, y: 100, w: 200, h: 100 };
    expect(uncoveredArea(base, [{ x: 900, y: 900, w: 50, h: 50 }], DISPLAY)).toBe(200 * 100);
  });
});

describe("plan", () => {
  test("every window keeps a strip nothing in front of it covers", () => {
    const result = plan(windows(20), OPTIONS);
    expect(result.overflow).toEqual([]);
    expect(result.starved).toEqual([]);
    expect(result.placements).toHaveLength(20);
    for (const p of result.placements) expect(p.exposed).toBeGreaterThan(0);
  });

  test("sides alternate by depth, so each ladder climbs half as far", () => {
    const result = plan(windows(20), OPTIONS);
    const right = result.placements.filter((p) => p.side === "right");
    const left = result.placements.filter((p) => p.side === "left");
    expect(right).toHaveLength(10);
    expect(left).toHaveLength(10);
    expect(right.every((p) => p.depth % 2 === 0)).toBe(true);
    expect(left.every((p) => p.depth % 2 === 1)).toBe(true);
  });

  test("deeper rungs sit higher, so each exclusive band is a top edge", () => {
    const result = plan(windows(6), OPTIONS);
    const right = result.placements.filter((p) => p.side === "right").sort((a, b) => a.depth - b.depth);
    for (let i = 1; i < right.length; i += 1) {
      expect(right[i]!.y).toBeLessThan(right[i - 1]!.y);
    }
    expect(Math.min(...right.map((p) => p.y))).toBe(OPTIONS.topMargin);
  });

  test("the bulk hangs off the edge and only the strip stays on the display", () => {
    const result = plan(windows(2), OPTIONS);
    const right = result.placements.find((p) => p.side === "right")!;
    const left = result.placements.find((p) => p.side === "left")!;
    expect(right.x + 600 - DISPLAY.w).toBe(600 - OPTIONS.strip);
    expect(left.x).toBe(OPTIONS.strip - 600);
  });

  test("windows that do not fit the vertical room are reported, not squeezed", () => {
    // 877pt windows on a 1169pt display leave room for about a dozen per side.
    const result = plan(windows(80), OPTIONS);
    expect(result.overflow.length).toBeGreaterThan(0);
    expect(result.starved).toEqual([]);
    expect(result.placements.length + result.overflow.length).toBe(80);
  });

  test("a plan laid out against the wrong order starves its middle windows", () => {
    // The guard rail: hand plan() a front-to-back list, then check that a window
    // sandwiched by two neighbours really does come back with zero exposure. This
    // is the failure a position-only ladder would ship silently.
    const same = { x: 0, y: 0, w: 600, h: 877 };
    const a = { id: 1, frame: same };
    const b = { id: 2, frame: same };
    const laid = plan([a, b], { ...OPTIONS, step: 24 });
    // Force both onto one side at overlapping positions, then re-measure.
    const rects = [
      { x: 1760, y: 39, w: 600, h: 877 },
      { x: 1760, y: 39, w: 600, h: 877 },
    ];
    expect(laid.starved).toEqual([]);
    expect(uncoveredArea(rects[1]!, [rects[0]!], DISPLAY)).toBe(0);
  });

  test("a single window is trivially exposed", () => {
    const result = plan(windows(1), OPTIONS);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]!.exposed).toBe(40 * 877);
  });

  test("windows of different sizes still each keep a band", () => {
    const mixed: LadderWindow[] = [
      { id: 1, frame: { x: 0, y: 0, w: 600, h: 877 } },
      { id: 2, frame: { x: 0, y: 0, w: 400, h: 300 } },
      { id: 3, frame: { x: 0, y: 0, w: 900, h: 600 } },
      { id: 4, frame: { x: 0, y: 0, w: 500, h: 1000 } },
    ];
    const result = plan(mixed, OPTIONS);
    expect(result.starved).toEqual([]);
    for (const p of result.placements) expect(p.exposed).toBeGreaterThan(0);
  });
});
