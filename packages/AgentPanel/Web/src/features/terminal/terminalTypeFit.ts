/**
 * How finely the type is sized.
 *
 * Whole points waste up to a point's worth of whichever axis binds, and at the floor a point is an
 * eighth of the size. Measured on a 179-column tmux pane in a 968-pixel band: the largest whole
 * point that fitted left 53 pixels dead down EACH side, which reads as padding nobody asked for
 * rather than as type that stopped growing. A tenth of a point is not a size anyone can see, and
 * the same pane fits at 8.6 with only the band's own padding left over.
 *
 * It buys real width rather than rounding back to the same layout: measured across 8.0 to 9.5 in
 * tenths, every step moved the cell (4.816, 4.877, 4.937, ...), because the font's metrics are
 * continuous in its size.
 */
export const FONT_SIZE_STEP = 0.1;

const STEPS_PER_POINT = 1 / FONT_SIZE_STEP;

/**
 * The largest size at or below `size` that the fit is allowed to use.
 *
 * Floored, so the screen never overflows by the rounding in a cell's own metrics -- with a hair of
 * tolerance, because an exact fit computes as 0.99999 often enough to cost a step for nothing.
 */
export function floorToStep(size: number): number {
  return Math.floor(size * STEPS_PER_POINT + 0.01) / STEPS_PER_POINT;
}

/**
 * How large the type may be, for a terminal whose grid this side does not own.
 *
 * A tmux pane is whatever shape its own terminal made it -- 41 columns by 20 rows, measured -- and
 * the band showing it is nothing like that shape. The grid cannot be changed to suit: tmux has one
 * window size for everyone and setting it from a viewer reflows the session in whatever terminal
 * its owner has it open in, which is why `tmuxAttachment` reports the pane's size and never sets
 * it. So the grid keeps its shape and the type grows or shrinks until the whole screen fits.
 *
 * Arithmetic from one reading at the base size, which gets close and not all the way: a cell is
 * NOT quite proportional to its font (13pt gives one 16 tall, 28pt gives 35.5, where the ratio
 * predicts 34.5), so whoever calls this settles the answer downward against real metrics.
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
  return Math.max(minimum, Math.min(maximum, floorToStep(baseFontSize * scale)));
}

/**
 * How tall the screen wants to be: the height at which the type fills the width it has.
 *
 * A pane that asks for the height the screen needs at the BASE size can never show it any larger,
 * because the fit then finds the height exactly binding and confirms the size it started from. The
 * width is the axis with room to spare -- a 53-column pane in a window-wide band uses a third of it
 * -- so the height worth asking for is the one that spends it.
 *
 * Whoever asks still has to cap it: this answers what the screen wants, not what the surface can
 * afford, and a tall grid can want more than the whole card.
 */
export function preferredScreenHeight(reading: {
  baseFontSize: number;
  cell: { width: number; height: number };
  grid: { columns: number; rows: number };
  /** The width the screen has, padding already taken off. */
  availableWidth: number;
  minimum: number;
  maximum: number;
}): number | null {
  const fontSize = fittedFontSize({
    baseFontSize: reading.baseFontSize,
    cell: reading.cell,
    grid: reading.grid,
    // Unbounded on the axis being spent, so only the width decides.
    available: { width: reading.availableWidth, height: Number.POSITIVE_INFINITY },
    minimum: reading.minimum,
    maximum: reading.maximum,
  });
  if (fontSize === null) return null;
  return Math.round(
    reading.cell.height * reading.grid.rows * (fontSize / reading.baseFontSize),
  );
}
