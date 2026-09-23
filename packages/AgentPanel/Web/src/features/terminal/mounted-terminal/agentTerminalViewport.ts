// What a tile's drag asks through without reopening the attachment.
//
// One idea, out of the mount effect because that file is at its line cap: the drag's grid,
// who it is for, and the local terminal that takes it when the pane must not. A follower
// takes the grid locally and never asks the pane -- tmux has one window size for everyone,
// so asking would reflow the session in its owner's terminal -- while a claiming surface
// stages it for the viewport report that resizes the pane.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { clampTileGrid } from "@/features/terminal/terminalTileSize";
import type { TerminalRuntime } from "@/features/terminal/mounted-terminal/agentTerminalRuntime";
import type {
  Dimensions,
  TerminalSizing,
  TileGridRequest,
} from "@/features/terminal/mounted-terminal/agentTerminalTypes";

/**
 * The drag's grid plus what the fixed-sizing report reads.
 *
 * `currentGrid` is what `publishViewport` reports for a fixed tile: the staged grid, or
 * null before the first drag so the report falls back to the opening one. A repeat of the
 * grid on screen sends nothing, which keeps pointermove out of tmux; the pane's own moves
 * still snap the tile back through the checkpoint, so the live grid is the comparison for
 * a follower and the staged one for everyone else.
 */
export interface TileViewportRequest extends TileGridRequest {
  /** Rests at the arranged grid without reporting; the scheduled report carries it. */
  restAt: (columns: number, rows: number) => void;
  currentGrid: () => Dimensions | null;
}

export function createTileViewportRequest(args: {
  terminal: XtermTerminal;
  /** The runtime whose fit runs after a local resize. Read at call time, not creation. */
  t: TerminalRuntime;
  sizing: TerminalSizing;
  adoptsPaneShape: boolean;
  paneAuthoritative: boolean;
  /** Sent after the grid is staged (and taken locally, for a follower). */
  report: () => void;
}): TileViewportRequest {
  const { terminal, t, sizing, adoptsPaneShape, paneAuthoritative, report } = args;
  // A tile's drag asks for a grid the mount never had. Null until the first drag; a
  // follower keeps it for the report alone, since its local terminal already took the grid
  // and this is the view half of a viewport the pane never answers with a resize.
  let wantedGrid: Dimensions | null = null;
  // Stages the grid and takes it locally for a follower. True when it moved: a repeat of
  // the grid on screen stages nothing, which keeps pointermove out of tmux.
  const stage = (grid: Dimensions): boolean => {
    const live = paneAuthoritative && !adoptsPaneShape
      ? { columns: terminal.cols, rows: terminal.rows }
      : null;
    const current = live
      ?? wantedGrid
      ?? (sizing.kind === "fixed" ? { columns: sizing.columns, rows: sizing.rows } : null);
    if (current && current.columns === grid.columns && current.rows === grid.rows) return false;
    wantedGrid = grid;
    if (live) {
      terminal.resize(grid.columns, grid.rows);
      t.fitType();
    }
    return true;
  };
  return {
    resizeGrid: (columns, rows) => {
      if (stage(clampTileGrid({ columns, rows }))) report();
    },
    /**
     * Rests at the arranged grid without reporting: the open re-applies the reader's box,
     * and the scheduled first report below carries it. Reporting here as well would send
     * the same viewport twice per open -- and synchronously, ahead of the debounce the
     * drag tests pin their counts to.
     */
    restAt: (columns, rows) => {
      stage(clampTileGrid({ columns, rows }));
    },
    currentGrid: () => wantedGrid,
    measureGrid: () => {
      const columns = terminal.cols;
      const rows = terminal.rows;
      return columns > 0 && rows > 0 ? { columns, rows } : null;
    },
    measureCell: () => {
      const cell = terminal.dimensions?.css.cell;
      return cell && cell.width > 0 && cell.height > 0
        ? { width: cell.width, height: cell.height }
        : null;
    },
  };
}
