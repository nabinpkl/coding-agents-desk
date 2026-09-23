/**
 * The grid a terminal tile opens at, remembered per session.
 *
 * A tile is 60x30 until its reader drags it somewhere else, and the next visit should find it
 * where it was left -- the same arrangement-memory the canvas keeps for which children are open.
 * Keyed by child key (`machine:name`, the same string the open set uses) because tmux names are
 * unique per server and meaningless across machines.
 *
 * Every read and write is wrapped in `try`/`catch`, because a private window and a container with
 * storage disabled both throw -- the house rule from `AGENTS.md`. Identity only: a hand-edited
 * value outside the bounds below is dropped, never clamped into authority it was not given.
 */

export const DEFAULT_TILE_GRID = { columns: 60, rows: 30 };

/** The drag may ask for anything; the pane keeps what tmux can hold. */
const TILE_GRID_BOUNDS = {
  minColumns: 20,
  maxColumns: 320,
  minRows: 5,
  maxRows: 100,
};

export interface TileGrid {
  columns: number;
  rows: number;
}

const TILE_GRID_KEY = "agent-panel.terminal.tile-grid";

function isTileGrid(value: unknown): value is TileGrid {
  if (typeof value !== "object" || value === null) return false;
  const grid = value as Record<string, unknown>;
  return (
    Number.isInteger(grid["columns"])
    && Number.isInteger(grid["rows"])
    && (grid["columns"] as number) >= TILE_GRID_BOUNDS.minColumns
    && (grid["columns"] as number) <= TILE_GRID_BOUNDS.maxColumns
    && (grid["rows"] as number) >= TILE_GRID_BOUNDS.minRows
    && (grid["rows"] as number) <= TILE_GRID_BOUNDS.maxRows
  );
}

/** The drag's ask, bounded before it reaches the pane or the store. */
export function clampTileGrid(grid: TileGrid): TileGrid {
  const columns = Number.isFinite(grid.columns) ? Math.trunc(grid.columns) : DEFAULT_TILE_GRID.columns;
  const rows = Number.isFinite(grid.rows) ? Math.trunc(grid.rows) : DEFAULT_TILE_GRID.rows;
  return {
    columns: Math.min(Math.max(columns, TILE_GRID_BOUNDS.minColumns), TILE_GRID_BOUNDS.maxColumns),
    rows: Math.min(Math.max(rows, TILE_GRID_BOUNDS.minRows), TILE_GRID_BOUNDS.maxRows),
  };
}

function loadTileGrids(): Record<string, TileGrid> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(TILE_GRID_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const grids: Record<string, TileGrid> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && isTileGrid(value)) grids[key] = value;
    }
    return grids;
  } catch {
    return {};
  }
}

export function loadTileGrid(storageKey: string): TileGrid {
  return loadTileGrids()[storageKey] ?? { ...DEFAULT_TILE_GRID };
}

export function storeTileGrid(storageKey: string, grid: TileGrid): void {
  try {
    const grids = loadTileGrids();
    grids[storageKey] = clampTileGrid(grid);
    localStorage.setItem(TILE_GRID_KEY, JSON.stringify(grids));
  } catch {
    // The tile still resizes; it just opens at the default next time.
  }
}

/**
 * The box a tile's mount is drawn at, in CSS pixels, remembered per session.
 *
 * The grid is the pane's shape now -- a follower never takes its own -- so what the reader
 * arranges is the presentation: how much room the pane's screen gets. Null until arranged,
 * and the mount shrink-wraps the screen while it stays null. Bounded like the grid above,
 * for the same reason: a hand-edited value is dropped, never honoured.
 */

export interface TileBox {
  width: number;
  height: number;
}

const TILE_BOX_KEY = "agent-panel.terminal.tile-box";

/** Small enough to still read at the type floor, large enough to stay a tile. */
const TILE_BOX_BOUNDS = {
  minWidth: 144,
  maxWidth: 1600,
  minHeight: 96,
  maxHeight: 1200,
};

function isTileBox(value: unknown): value is TileBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (
    Number.isFinite(box["width"])
    && Number.isFinite(box["height"])
    && (box["width"] as number) >= TILE_BOX_BOUNDS.minWidth
    && (box["width"] as number) <= TILE_BOX_BOUNDS.maxWidth
    && (box["height"] as number) >= TILE_BOX_BOUNDS.minHeight
    && (box["height"] as number) <= TILE_BOX_BOUNDS.maxHeight
  );
}

/** The drag's ask, bounded before it reaches the screen or the store. */
export function clampTileBox(box: TileBox): TileBox {
  const width = Number.isFinite(box.width) ? box.width : TILE_BOX_BOUNDS.minWidth;
  const height = Number.isFinite(box.height) ? box.height : TILE_BOX_BOUNDS.minHeight;
  return {
    width: Math.min(Math.max(Math.round(width), TILE_BOX_BOUNDS.minWidth), TILE_BOX_BOUNDS.maxWidth),
    height: Math.min(Math.max(Math.round(height), TILE_BOX_BOUNDS.minHeight), TILE_BOX_BOUNDS.maxHeight),
  };
}

function loadTileBoxes(): Record<string, TileBox> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(TILE_BOX_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const boxes: Record<string, TileBox> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && isTileBox(value)) boxes[key] = value;
    }
    return boxes;
  } catch {
    return {};
  }
}

/** Null until the reader arranges one: the mount shrink-wraps the screen meanwhile. */
export function loadTileBox(storageKey: string): TileBox | null {
  return loadTileBoxes()[storageKey] ?? null;
}

export function storeTileBox(storageKey: string, box: TileBox): void {
  try {
    const boxes = loadTileBoxes();
    boxes[storageKey] = clampTileBox(box);
    localStorage.setItem(TILE_BOX_KEY, JSON.stringify(boxes));
  } catch {
    // The tile still holds its box; it just shrink-wraps next time.
  }
}
