// Making the type fit a box whose grid this side does not own.
//
// A tmux pane is whatever shape its own terminal made it, and the band showing it is not
// that shape. Rather than reshaping the pane, the type is scaled until the pane's screen
// fits the box; every measurement below is why the arithmetic is done once.

import {
  BASE_FONT_SIZE,
  MAXIMUM_FONT_SIZE,
  MINIMUM_FONT_SIZE,
  paddingOf,
} from "@/features/terminal/mounted-terminal/agentTerminalLayout";
import {
  fittedFontSize,
  floorToStep,
  FONT_SIZE_STEP,
  preferredScreenHeight,
  surfaceInset,
  viewerSetsGrid,
} from "@/features/terminal/mounted-terminal/terminalTypeFit";
import type { TerminalRuntime } from "@/features/terminal/mounted-terminal/agentTerminalRuntime";

export function createTerminalFit(t: TerminalRuntime) {
  /**
   * Scales the TYPE, for a grid this side does not own.
   *
   * A tmux pane is whatever shape its own terminal made it -- 41 columns by 20 rows, measured
   * -- and the band showing it is nothing like that shape. At a fixed type size the screen
   * therefore either ran off the bottom of the band and had to be scrolled, or sat in the
   * corner of a box several times its size. Neither is fixable by resizing the pane: tmux has
   * one window size for everyone and setting it from here reflows the session in whatever
   * terminal its owner has it open in, which is why `tmuxAttachment` refuses to.
   *
   * So the grid keeps its shape and the type grows or shrinks until the whole screen fits the
   * space. Measured ONCE, at the base size: cell metrics are proportional to the font, so
   * everything after that is arithmetic. Re-measuring after each change instead reads a layout
   * xterm has not finished writing, and iterating on that oscillates.
   */
  return (): void => {
    const cell = t.terminal.dimensions?.css.cell;
    if (!cell || cell.width <= 0 || cell.height <= 0) return;
    const grid = { columns: t.terminal.cols, rows: t.terminal.rows };
    if (!(grid.columns > 0) || !(grid.rows > 0)) return;
    // Captured while the type is still at base, which is the only moment it means anything.
    // Not a gate on the whole fit: a viewer that sets the grid never scales its type and has
    // no use for a base cell, and gating on it there froze a pane whose reader had already
    // chosen a size, since the size that blocked the capture was also the one it would not
    // then update.
    if (!t.baseCell && t.terminal.options.fontSize === BASE_FONT_SIZE) {
      t.baseCell = { width: cell.width, height: cell.height };
    }
    // A grid this viewer ASKED for already fits the box at base type, because that is exactly
    // what it was computed from. Scaling it as well puts two controllers on one box, and they
    // do not agree: the fit stretches the type to fill the width, that changes the rendered
    // height and whether a scrollbar is there, the next report measures a different box and
    // asks for a different grid. Measured on two live cards that nobody was touching -- both
    // cycled 40 -> 45 -> 50 -> 40 columns twice a second for as long as they were open.
    //
    // So exactly one of the two runs, and `viewerSetsGrid` decides which before any report
    // arrives. Ours: the type is an input -- base, or whatever the reader chose -- and the grid
    // follows the box. Not ours: the grid is fixed and the type follows it, which is everything
    // below.
    if (t.ownsPaneShape) {
      // The reader's size outranks the base one here too, and costs nothing to honour: the
      // grid is the OUTPUT on this side, so larger type means fewer columns in the same box
      // rather than a screen that overflows it. Forcing base instead left the footer's own
      // control dead on every pane a viewer sizes.
      const size = t.zoomRef.current ?? BASE_FONT_SIZE;
      if (t.terminal.options.fontSize !== size) t.terminal.options.fontSize = size;
      t.setFontSize(t.terminal.options.fontSize ?? null);
      // The band sizes itself from this, and a height asked for on behalf of a grid that is
      // already the right shape is the loop's other half.
      t.setContentHeight(null);
      return;
    }
    // Only the scaling below needs it, and it is absent until a frame lands at the base size.
    if (!t.baseCell) return;
    // Both boxes: the mount is the space the band gives, and the terminal element carries the
    // padding that makes the screen read as a screen rather than as a block of text. Missing
    // the second one sizes the grid to the whole space and then adds the padding to it, which
    // is an overflow and a scrollbar for the sake of eight pixels.
    const padding = paddingOf(t.mount);
    // Measured with any inset from a previous pass taken back off, because the inset is
    // derived from the space and would otherwise eat it a little more on every reflow.
    const frame = t.terminal.element;
    if (frame) frame.style.paddingInline = "";
    const framePadding = frame ? paddingOf(frame) : { width: 0, height: 0 };
    const available = {
      width: t.mount.clientWidth - padding.width - framePadding.width,
      height: t.mount.clientHeight - padding.height - framePadding.height,
    };
    // What the mount must be for the screen to spend the width it has, padding included,
    // because that is what the pane holding it can act on. NOT the height at the base size:
    // asking for that is asking to stay at the base size forever, since the fit below would
    // then find the height exactly binding every time.
    const chosen = t.zoomRef.current;
    // The height the screen wants, at whichever size is going to be in force. Asked for even
    // when the reader has chosen one, so the pane grows to hold their choice and only the
    // width is left to scroll.
    const wanted = chosen !== null
      ? Math.round(t.baseCell.height * grid.rows * (chosen / BASE_FONT_SIZE))
      : preferredScreenHeight({
        baseFontSize: BASE_FONT_SIZE,
        cell: t.baseCell,
        grid,
        availableWidth: available.width,
        maximum: MAXIMUM_FONT_SIZE,
        minimum: MINIMUM_FONT_SIZE,
      });
    if (wanted !== null) {
      t.setContentHeight(wanted + padding.height + framePadding.height);
    }
    // A reader who has said what size they want has answered the question this fit exists to
    // ask, so it stops asking. The screen overflows and scrolls where the choice does not fit,
    // which is what choosing one bigger than the box means.
    if (chosen !== null) {
      if (t.terminal.options.fontSize !== chosen) t.terminal.options.fontSize = chosen;
      t.setFontSize(chosen);
    } else {
    const fitted = fittedFontSize({
      baseFontSize: BASE_FONT_SIZE,
      cell: t.baseCell,
      grid,
      available,
      maximum: MAXIMUM_FONT_SIZE,
      minimum: MINIMUM_FONT_SIZE,
    });
    // Nothing measurable to fit against, which is every render before the mount has a size.
    if (fitted === null) return;
    if (fitted !== t.terminal.options.fontSize) t.terminal.options.fontSize = fitted;
    // Then settle it against the real metrics, because a cell is not proportional to its font:
    // measured on this pane, 13pt gives a cell 16 tall and 28pt gives 35.5, where the ratio
    // predicts 34.5. The arithmetic above is therefore a starting point that can overshoot by a
    // few percent -- enough for a scrollbar -- and xterm updates `dimensions` synchronously
    // with the option, so the overshoot is readable straight away. Only ever downward, so this
    // settles instead of hunting.
    for (let step = 0; step < 6; step += 1) {
      // Annotated because the assignment below feeds back into inferring this.
      const size: number = t.terminal.options.fontSize ?? BASE_FONT_SIZE;
      // The floor binds here too. This loop only ever shrinks, so without the guard it walks
      // straight back through a floored fit to whatever fits exactly -- measured on an
      // 80-column pane in a card's band: the fit floored at 11 and this settled it to 9.4.
      // Below the floor the answer is to overflow and scroll, not to keep shrinking.
      if (size <= Math.max(MINIMUM_FONT_SIZE, FONT_SIZE_STEP)) break;
      const actual = t.terminal.dimensions?.css.cell;
      if (!actual) break;
      // At or above 1 the screen fits; below it, it is the fraction of the size that would.
      const headroom = Math.min(
        available.width / (actual.width * grid.columns),
        available.height / (actual.height * grid.rows),
      );
      // A hair of tolerance, for the same reason the fit itself carries one: an exact fit
      // computes as 0.99999 often enough to cost a step for nothing.
      if (headroom >= 0.999) break;
      // Re-solved from the size actually in force rather than stepped down blindly, so an
      // overshoot of any size is answered in one move; the second term only guarantees the
      // loop moves at all when the solve rounds back to where it started.
      const solved = floorToStep(size * headroom);
      const next = Math.max(
        MINIMUM_FONT_SIZE,
        FONT_SIZE_STEP,
        solved < size ? solved : floorToStep(size - FONT_SIZE_STEP),
      );
      if (next >= size) break;
      t.terminal.options.fontSize = next;
    }
    t.setFontSize(t.terminal.options.fontSize ?? null);
    }
    const settled = t.terminal.dimensions?.css.cell;
    if (frame && settled) {
      const inset = surfaceInset({
        availableWidth: available.width,
        screenWidth: settled.width * grid.columns,
        basePadding: framePadding.width / 2,
      });
      frame.style.paddingInline = inset === null ? "" : `${inset}px`;
    }
  };
}
