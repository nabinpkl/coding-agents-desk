import { expect, test } from "vitest";
import {
  clampTileGrid,
  DEFAULT_TILE_GRID,
  loadTileGrid,
  storeTileGrid,
} from "@/features/terminal/terminalTileSize";

test("bounds the drag before it reaches the pane", () => {
  expect(clampTileGrid({ columns: 8, rows: 200 })).toEqual({ columns: 20, rows: 100 });
  expect(clampTileGrid({ columns: 400, rows: 2 })).toEqual({ columns: 320, rows: 5 });
  expect(clampTileGrid({ columns: 100.7, rows: 30.2 })).toEqual({ columns: 100, rows: 30 });
});

test("a session opens where its reader left it, and an unknown one at the default", () => {
  storeTileGrid(":test-session", { columns: 120, rows: 36 });
  expect(loadTileGrid(":test-session")).toEqual({ columns: 120, rows: 36 });
  expect(loadTileGrid(":never-seen")).toEqual({ ...DEFAULT_TILE_GRID });
});

test("stores the bounded grid rather than the drag's ask", () => {
  storeTileGrid(":bounded-session", { columns: 9999, rows: 1 });
  expect(loadTileGrid(":bounded-session")).toEqual({ columns: 320, rows: 5 });
});
