// Where windows go when the desk is used as a board rather than a ladder.
//
// This is the ladder's opposite. `ladder.ts` hides windows behind each other on
// purpose, leaving each one a strip so it keeps rendering; this lays them out so
// all of them are legible at once. They share the Rect and the yabai calls and
// nothing else, so do not read one for the other's intent.
//
// Pure geometry, no I/O: the arithmetic is testable without a window server,
// which matters because the only desk it is aimed at lives in another login
// session that a test process cannot reach.

import type { Rect } from "./ladder.ts";

/** A window's own idea of how big it should be. */
export interface Placeable {
  w: number;
  h: number;
}

/**
 * Pack windows from the top-left of `area`, left to right, wrapping to a new row
 * when the next one would cross the right edge.
 *
 * Deliberately not an even division of the display. Splitting 7680pt into three
 * columns and dropping an 860pt terminal at the top-left of each leaves 1600pt
 * of desk between neighbours, which reads as three unrelated windows rather than
 * as a board. Packing instead means the gap between two windows is the gap, and
 * the leftover space collects at the right and bottom where it costs nothing.
 *
 * Windows keep their own size and are only shrunk to fit the area, never grown:
 * a wider terminal is not a more readable one.
 */
export function packFromTopLeft(
  area: Rect,
  sizes: readonly Placeable[],
  gap: number,
): Rect[] {
  if (gap < 0) throw new RangeError(`gap must not be negative, got ${gap}`);
  const maxWidth = area.w - gap * 2;
  const maxHeight = area.h - gap * 2;
  if (sizes.length > 0 && (maxWidth <= 0 || maxHeight <= 0)) {
    throw new RangeError(`${area.w}x${area.h} cannot hold anything with a ${gap}pt gap`);
  }

  const placed: Rect[] = [];
  let x = area.x + gap;
  let y = area.y + gap;
  let rowHeight = 0;
  for (const size of sizes) {
    const w = Math.min(size.w, maxWidth);
    const h = Math.min(size.h, maxHeight);
    // Wrap, unless this is already the first window of a row: one too wide for
    // the whole area has nowhere better to go, and wrapping it would leave an
    // empty row above it.
    if (x > area.x + gap && x + w > area.x + area.w - gap) {
      x = area.x + gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    placed.push({ x, y, w, h });
    x += w + gap;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

/**
 * The part of a display a window may actually occupy.
 *
 * macOS refuses to put a window under the menu bar, so a layout computed against
 * the raw display frame has its whole top row clamped downward into the second.
 * The inset is a property of the desk, not of the caller, which is why it lives
 * next to the geometry that has to respect it.
 */
export function usableArea(displayFrame: Rect, menuBarInset: number): Rect {
  return {
    x: displayFrame.x,
    y: displayFrame.y + menuBarInset,
    w: displayFrame.w,
    h: displayFrame.h - menuBarInset,
  };
}
