/**
 * How large the type may be, for a terminal whose grid this side does not own.
 *
 * A tmux pane is whatever shape its own terminal made it -- 41 columns by 20 rows, measured -- and
 * the band showing it is nothing like that shape. The grid cannot be changed to suit: tmux has one
 * window size for everyone and setting it from a viewer reflows the session in whatever terminal
 * its owner has it open in, which is why `tmuxAttachment` reports the pane's size and never sets
 * it. So the grid keeps its shape and the type grows or shrinks until the whole screen fits.
 *
 * Arithmetic rather than measurement: cell metrics are proportional to the font, so one reading at
 * the base size answers every size after it. Re-measuring after each change instead reads a layout
 * xterm has not finished writing, and iterating on that oscillates.
 */
export function fittedFontSize(reading: {
  /** The size the cell below was measured at. */
  baseFontSize: number;
  /** One cell at that size, in CSS pixels. */
  cell: { width: number; height: number };
  grid: { columns: number; rows: number };
  /** The box the whole grid has to fit inside, padding already taken off. */
  available: { width: number; height: number };
  minimum: number;
  maximum: number;
}): number | null {
  const { baseFontSize, cell, grid, available, minimum, maximum } = reading;
  if (!(cell.width > 0) || !(cell.height > 0)) return null;
  if (!(grid.columns > 0) || !(grid.rows > 0)) return null;
  if (!(available.width > 0) || !(available.height > 0)) return null;
  const scale = Math.min(
    available.width / (cell.width * grid.columns),
    available.height / (cell.height * grid.rows),
  );
  // Floored, so the screen never overflows by the rounding in a cell's own metrics -- with a hair
  // of tolerance, because an exact fit computes as 0.99999 often enough to cost a whole point of
  // type for nothing.
  return Math.max(minimum, Math.min(maximum, Math.floor(baseFontSize * scale + 0.001)));
}
