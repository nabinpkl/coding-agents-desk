// The arithmetic behind a terminal whose grid belongs to the far end. Worth pinning on its own:
// jsdom measures every box at zero, so the browser cannot exercise it, and the failure it prevents
// is silent -- a screen that scrolls or a screen in the corner of its own box.

import { expect, test } from "vitest";
import { fittedFontSize, preferredScreenHeight } from "./terminalTypeFit";

const reading = (available: { width: number; height: number }) => ({
  baseFontSize: 13,
  cell: { width: 7.51, height: 16 },
  grid: { columns: 41, rows: 20 },
  available,
  minimum: 8,
  maximum: 28,
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

test("shrinks rather than scrolls, down to a floor", () => {
  // 13 x (235/320) is 9.55, and the tenth below it is the answer: rounding that down to 9 would
  // leave half a point of the binding axis unspent, which is dead space down both sides of a
  // screen that has already stopped growing.
  expect(fittedFontSize(reading({ width: 942, height: 235 }))).toBe(9.5);
  // Below the floor the screen stops shrinking and the pane scrolls instead: type nobody can read
  // is not a way of showing them a terminal.
  expect(fittedFontSize(reading({ width: 942, height: 60 }))).toBe(8);
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
  minimum: 8,
  maximum: 28,
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
