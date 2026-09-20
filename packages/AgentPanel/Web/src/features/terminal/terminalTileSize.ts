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
