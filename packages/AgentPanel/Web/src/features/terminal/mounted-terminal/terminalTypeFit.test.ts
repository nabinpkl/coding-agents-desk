// The arithmetic behind a terminal whose grid belongs to the far end. Worth pinning on its own:
// jsdom measures every box at zero, so the browser cannot exercise it, and the failure it prevents
// is silent -- a screen that scrolls or a screen in the corner of its own box.

import { expect, test } from "vitest";
import { fittedFontSize, preferredScreenHeight, surfaceInset, viewerSetsGrid } from "@/features/terminal/mounted-terminal/terminalTypeFit";

const reading = (available: { width: number; height: number }) => ({
  baseFontSize: 13,
  cell: { width: 7.51, height: 16 },
  grid: { columns: 41, rows: 20 },
  available,
  maximum: 28,
  // Most cases here are about the arithmetic between the floor and the ceiling, so they set it out
  // of the way; the two that are ABOUT the floor say so.
  minimum: 0,
});

test("keeps the base size when the screen already fits exactly", () => {
  // 41 x 7.51 = 308 wide, 20 x 16 = 320 tall. An exact fit computes as 0.9999-something, and
  // flooring that without tolerance costs a whole point of type for nothing.
  expect(fittedFontSize(reading({ width: 308, height: 320 }))).toBe(13);
});

test("takes the tighter of the two axes", () => {
  // Room to spare across, none of it usable: a grid keeps its shape, so the short axis decides.
  expect(fittedFontSize(reading({ width: 942, height: 320 }))).toBe(13);
  expect(fittedFontSize(reading({ width: 942, height: 640 }))).toBe(26);
  expect(fittedFontSize(reading({ width: 308, height: 640 }))).toBe(13);
});

test("shrinks as far as the box demands, down to the floor it is given", () => {
  // 13 x (235/320) is 9.55, and the tenth below it is the answer: rounding that down to 9 would
  // leave half a point of the binding axis unspent, which is dead space down both sides of a
  // screen that has already stopped growing.
  expect(fittedFontSize(reading({ width: 942, height: 235 }))).toBe(9.5);
  expect(fittedFontSize(reading({ width: 942, height: 60 }))).toBe(2.4);
  expect(fittedFontSize(reading({ width: 942, height: 20 }))).toBe(0.8);
});

test("stops shrinking at the floor, and lets the screen overflow instead", () => {
  // The floor that used to be here CLIPPED, which is why there was none: the grid stopped
  // shrinking and a wide pane in a narrow card lost its right-hand columns silently. Overflow
  // scrolls now -- measured on a live band, a screen forced wider than its mount moved
  // `scrollLeft` -- so the trade is a short scroll against type nobody can read, and the screen
  // stays complete either way.
  const floored = (available: { width: number; height: number }) =>
    fittedFontSize({ ...reading(available), minimum: 11 });
  expect(floored({ width: 942, height: 235 })).toBe(11);
  expect(floored({ width: 942, height: 20 })).toBe(11);
  // The floor never pushes type UP past what the box can hold at the ceiling, nor overrides a fit
  // that is already comfortable.
  expect(floored({ width: 942, height: 640 })).toBe(26);
});

test("sizes to a tenth of a point, and never past what fits", () => {
  // Every tenth in the range is a size the font actually renders differently -- measured, the cell
  // moved at each of 8.0, 8.1, 8.2 -- so the finer step buys width rather than the same layout.
  const sizes = [235, 236, 237, 238, 239, 240].map((height) =>
    fittedFontSize(reading({ width: 942, height })));
  expect(sizes).toEqual([9.5, 9.5, 9.6, 9.6, 9.7, 9.7]);
  for (const [index, size] of sizes.entries()) {
    expect(size! * (16 / 13) * 20).toBeLessThanOrEqual(235 + index);
  }
});

test("stops growing before a small screen stops looking like a terminal", () => {
  expect(fittedFontSize(reading({ width: 4000, height: 4000 }))).toBe(28);
});

test("answers nothing for a box or a grid it cannot measure", () => {
  expect(fittedFontSize(reading({ width: 0, height: 320 }))).toBeNull();
  expect(fittedFontSize({ ...reading({ width: 308, height: 320 }), grid: { columns: 41, rows: 0 } }))
    .toBeNull();
  expect(fittedFontSize({ ...reading({ width: 308, height: 320 }), cell: { width: 0, height: 16 } }))
    .toBeNull();
});

const wanting = (availableWidth: number) => ({
  baseFontSize: 13,
  cell: { width: 7.83, height: 16 },
  grid: { columns: 53, rows: 15 },
  availableWidth,
  maximum: 28,
  minimum: 0,
});

test("asks for the height that spends the width, not the height at the base size", () => {
  // 53 x 7.83 = 415 wide at the base size. A band four times that wide has room for type four
  // times the size, and the height that buys is what the pane should ask for -- asking for the
  // base-size height instead pins the screen at the base size, because the fit then finds the
  // height exactly binding and confirms what it started from.
  expect(preferredScreenHeight(wanting(415))).toBe(15 * 16);
  expect(preferredScreenHeight(wanting(830))).toBe(15 * 32);
});

test("stops asking at the largest type it would use", () => {
  // Capped at 28 of a base 13, so the tallest it ever asks for is that ratio of the screen.
  expect(preferredScreenHeight(wanting(100_000))).toBe(Math.round(15 * 16 * (28 / 13)));
});

test("asks for nothing when there is no width to measure", () => {
  expect(preferredScreenHeight(wanting(0))).toBeNull();
});

test("takes the whole band for a screen that nearly fills it", () => {
  // 937 of 952 available: the 15 left over are what a tenth of a point could not buy, and setting
  // the surface in by them would leave it a hair narrower than every event card above it.
  expect(surfaceInset({ availableWidth: 952, screenWidth: 937, basePadding: 8 })).toBe(15.5);
  // The whole point of the answer: surface width is screen + both insets, which is the band.
  expect(937 + 2 * 15.5).toBe(952 + 2 * 8);
});

test("leaves a screen that does not fill its band shrink-wrapped", () => {
  // A 41-column tmux pane in a window-wide band. Painting a surface across the band for this
  // leaves most of a black rectangle with nothing in it, which reads as something failing.
  expect(surfaceInset({ availableWidth: 952, screenWidth: 308, basePadding: 8 })).toBeNull();
  expect(surfaceInset({ availableWidth: 952, screenWidth: 761, basePadding: 8 })).toBeNull();
  expect(surfaceInset({ availableWidth: 952, screenWidth: 762, basePadding: 8 })).toBe(103);
});

test("leaves an overflowing or unmeasurable screen alone", () => {
  // Wider than its band is the case the mount scrolls for; an inset cannot help and a negative
  // one would pull the surface in past its own edges.
  expect(surfaceInset({ availableWidth: 952, screenWidth: 1200, basePadding: 8 })).toBeNull();
  expect(surfaceInset({ availableWidth: 0, screenWidth: 937, basePadding: 8 })).toBeNull();
  expect(surfaceInset({ availableWidth: 952, screenWidth: 0, basePadding: 8 })).toBeNull();
});

test("a terminal with no pane behind it sets its own grid", () => {
  // The case that regressed: only this box is asking, and the PTY takes every shape it is given,
  // so scaling the type as well is the second controller that made the grid walk.
  expect(viewerSetsGrid(false, "fit")).toBe(true);
});

test("a pane is asked rather than assumed, because somebody else may hold it", () => {
  // A tmux window has one size for everyone, so who owns it comes from the pane's own report and
  // not from the fact that this viewer would like to.
  expect(viewerSetsGrid(true, "fit")).toBe(false);
});

test("a fixed grid belongs to the caller, so the type follows it", () => {
  expect(viewerSetsGrid(false, "fixed")).toBe(false);
  expect(viewerSetsGrid(true, "fixed")).toBe(false);
});
