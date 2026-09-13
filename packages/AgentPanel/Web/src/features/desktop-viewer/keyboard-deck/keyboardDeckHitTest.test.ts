import { describe, expect, it } from "vitest";
import {
  cellAtPoint,
  deckHitCells,
  pointHoldsCell,
  type DeckRowBox,
} from "./keyboardDeckHitTest";

/** Two rows of a 100-wide deck: a full row of four, and an indented row of three below it. */
const ROWS: DeckRowBox[] = [
  {
    top: 10,
    bottom: 30,
    keys: [
      { left: 5, right: 25 },
      { left: 30, right: 50 },
      { left: 55, right: 75 },
      { left: 80, right: 95 },
    ],
  },
  {
    top: 40,
    bottom: 60,
    keys: [
      { left: 20, right: 40 },
      { left: 45, right: 65 },
      { left: 70, right: 90 },
    ],
  },
];
const SIZE = { width: 100, height: 70 };

describe("deck hit cells", () => {
  it("tiles the deck with no gap and no overlap", () => {
    const cells = deckHitCells(ROWS, SIZE);
    expect(cells[0]![0]).toMatchObject({ left: 0, right: 27.5, top: 0, bottom: 35 });
    expect(cells[0]![3]).toMatchObject({ left: 77.5, right: 100, top: 0, bottom: 35 });
    expect(cells[1]![0]).toMatchObject({ left: 0, right: 42.5, top: 35, bottom: 70 });
    expect(cells[1]![2]).toMatchObject({ left: 67.5, right: 100, top: 35, bottom: 70 });

    for (const row of cells) {
      expect(row[0]!.left).toBe(0);
      expect(row.at(-1)!.right).toBe(SIZE.width);
      for (const [index, cell] of row.entries()) {
        if (index > 0) expect(cell.left).toBe(row[index - 1]!.right);
      }
    }
    expect(cells[0]![0]!.bottom).toBe(cells[1]![0]!.top);
  });

  it("gives the padding around the deck to the nearest key", () => {
    // Above the top row, left of the first key, and below the bottom row: all inside a key's cell.
    expect(cellAtPoint(deckHitCells(ROWS, SIZE), { x: 2, y: 1 })).toMatchObject({ row: 0, key: 0 });
    expect(cellAtPoint(deckHitCells(ROWS, SIZE), { x: 99, y: 69 })).toMatchObject({ row: 1, key: 2 });
  });

  it("gives an indented row's margin to its own edge key, not to the row above", () => {
    // The point sits left of the second row's first key, in the indent. On the iPhone this types
    // that key; hit-testing the drawn rectangle would find nothing at all here.
    const hit = cellAtPoint(deckHitCells(ROWS, SIZE), { x: 8, y: 50 });
    expect(hit).toMatchObject({ row: 1, key: 0 });
  });

  it("splits a gap between the two keys that share it", () => {
    const cells = deckHitCells(ROWS, SIZE);
    expect(cellAtPoint(cells, { x: 27, y: 20 })).toMatchObject({ key: 0 });
    expect(cellAtPoint(cells, { x: 28, y: 20 })).toMatchObject({ key: 1 });
  });

  it("finds nothing outside the deck", () => {
    const cells = deckHitCells(ROWS, SIZE);
    expect(cellAtPoint(cells, { x: 50, y: -1 })).toBeNull();
    expect(cellAtPoint(cells, { x: 50, y: 70 })).toBeNull();
    expect(cellAtPoint(cells, { x: -1, y: 20 })).toBeNull();
    expect(cellAtPoint(cells, { x: 100, y: 20 })).toBeNull();
  });
});

describe("holding a cell", () => {
  const cell = deckHitCells(ROWS, SIZE)[0]![1]!;

  it("holds while the point is inside, or within the slop of it", () => {
    expect(pointHoldsCell(cell, { x: 40, y: 20 }, { x: 0, y: 0 })).toBe(true);
    expect(pointHoldsCell(cell, { x: cell.right + 5, y: 20 }, { x: 12, y: 20 })).toBe(true);
    expect(pointHoldsCell(cell, { x: cell.right + 20, y: 20 }, { x: 12, y: 20 })).toBe(false);
  });
});
