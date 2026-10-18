/**
 * Which key a touch belongs to, given that the keycaps are not the targets.
 *
 * On the iPhone keyboard there is no dead space: the gaps between keys, the padding around the
 * deck, and the indent either side of the home row all belong to whichever key is nearest, which is
 * why pressing just left of `a` types `a`. Hit-testing the drawn rectangles instead leaves every
 * seam inert, and at speed a large share of taps land in one.
 *
 * So the keycaps are drawn where the metrics say, and these cells -- which tile the deck exactly,
 * each key owning out to the midpoint of the gap with its neighbour and the edge keys owning out to
 * the deck's own border -- decide what was pressed.
 */

export interface DeckKeyBox {
  left: number;
  right: number;
}

export interface DeckRowBox {
  top: number;
  bottom: number;
  keys: readonly DeckKeyBox[];
}

export interface DeckCell {
  row: number;
  key: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface DeckSize {
  width: number;
  height: number;
}

/** Midpoint of the space between two edges; the boundary each side claims up to. */
function seam(before: number, after: number): number {
  return (before + after) / 2;
}

export function deckHitCells(rows: readonly DeckRowBox[], size: DeckSize): DeckCell[][] {
  return rows.map((row, rowIndex) => {
    const previous = rows[rowIndex - 1];
    const next = rows[rowIndex + 1];
    const top = previous ? seam(previous.bottom, row.top) : 0;
    const bottom = next ? seam(row.bottom, next.top) : size.height;
    return row.keys.map((key, keyIndex) => {
      const before = row.keys[keyIndex - 1];
      const after = row.keys[keyIndex + 1];
      return {
        row: rowIndex,
        key: keyIndex,
        left: before ? seam(before.right, key.left) : 0,
        right: after ? seam(key.right, after.left) : size.width,
        top,
        bottom,
      };
    });
  });
}

export function cellAtPoint(cells: readonly (readonly DeckCell[])[], point: { x: number; y: number }): DeckCell | null {
  for (const row of cells) {
    const first = row[0];
    if (!first || point.y < first.top || point.y >= first.bottom) continue;
    for (const cell of row) {
      if (point.x >= cell.left && point.x < cell.right) return cell;
    }
  }
  return null;
}

/**
 * Whether a press that started on this cell is still on it.
 *
 * The slop is what keeps an ordinary tap alive: a thumb that lands near a seam and rolls across it
 * has not chosen the neighbour, and UIKit likewise keeps tracking well outside a control's bounds
 * before it gives up on the touch.
 */
export function pointHoldsCell(
  cell: DeckCell,
  point: { x: number; y: number },
  slop: { x: number; y: number },
): boolean {
  return (
    point.x >= cell.left - slop.x &&
    point.x <= cell.right + slop.x &&
    point.y >= cell.top - slop.y &&
    point.y <= cell.bottom + slop.y
  );
}
