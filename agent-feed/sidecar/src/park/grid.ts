// Where windows go when the desk is used as a board rather than a ladder.
//
// This is the ladder's opposite. `ladder.ts` hides windows behind each other on
// purpose, leaving each one a strip so it keeps rendering; this spreads them out
// so all of them are legible at once. They share the Rect and the yabai calls
// and nothing else, so do not read one for the other's intent.
//
// Pure geometry, no I/O: the arithmetic is testable without a window server,
// which matters because the only desk it is aimed at lives in another login
// session that a test process cannot reach.

import type { Rect } from "./ladder.ts";

/**
 * Slot rectangles for `count` windows tiled over `area`, filled row by row.
 *
 * The last row is not left ragged. Five windows over three columns gives three
 * slots and then two wider ones, rather than three and a hole: on a desk this
 * size a hole reads as a window that failed to move, which is exactly the
 * failure this is supposed to make visible.
 *
 * Throws rather than returning degenerate slots. A zero-width slot is a window
 * told to have no surface, and yabai would report that as a clamp rather than
 * as the caller's arithmetic error.
 */
export function gridSlots(area: Rect, count: number, gap: number): Rect[] {
  if (count <= 0) return [];
  if (gap < 0) throw new RangeError(`gap must not be negative, got ${gap}`);
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const rowHeight = (area.h - gap * (rows + 1)) / rows;
  if (rowHeight <= 0) {
    throw new RangeError(`${area.h}pt of height cannot hold ${rows} rows with a ${gap}pt gap`);
  }
  const slots: Rect[] = [];
  let remaining = count;
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.ceil(remaining / (rows - row));
    remaining -= inRow;
    const slotWidth = (area.w - gap * (inRow + 1)) / inRow;
    if (slotWidth <= 0) {
      throw new RangeError(`${area.w}pt of width cannot hold ${inRow} columns with a ${gap}pt gap`);
    }
    for (let column = 0; column < inRow; column += 1) {
      slots.push({
        x: area.x + gap + column * (slotWidth + gap),
        y: area.y + gap + row * (rowHeight + gap),
        w: slotWidth,
        h: rowHeight,
      });
    }
  }
  return slots;
}

/**
 * The part of a display a window may actually occupy.
 *
 * macOS refuses to put a window under the menu bar, so a grid computed against
 * the raw display frame has its whole top row clamped downward and overlapping
 * the second. The inset is a property of the desk, not of the caller, which is
 * why it lives next to the geometry that has to respect it.
 */
export function usableArea(displayFrame: Rect, menuBarInset: number): Rect {
  return {
    x: displayFrame.x,
    y: displayFrame.y + menuBarInset,
    w: displayFrame.w,
    h: displayFrame.h - menuBarInset,
  };
}
