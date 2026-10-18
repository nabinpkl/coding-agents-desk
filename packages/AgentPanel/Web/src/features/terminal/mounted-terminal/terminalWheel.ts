// Sending the wheel to the program instead of scrolling the viewer's own buffer.
//
// Why there is anything to decide: a terminal viewer normally answers the wheel itself, because
// the bytes the reader is scrolling back over are in its buffer. On the ALTERNATE screen they are
// not, and no amount of importing will put them there -- tmux keeps no scrollback for the
// alternate screen at all, so `capture-pane` returns nothing above the visible page and the
// reader's wheel moves an empty buffer. Measured 2026-09-18 on a peer running Claude Code with
// `"tui": "fullscreen"`: `history_size=0` against 1869 on a pane running the same CLI in its
// default renderer.
//
// The history is not lost, it belongs to the program: a fullscreen renderer keeps its own and
// scrolls it when the terminal reports a wheel. So the wheel is forwarded, which is exactly what
// the program asked for by turning mouse tracking on, and what a real terminal does. Measured the
// same day against that peer's live pane: five forwarded reports moved its view back through
// content no capture could see, and twelve in the other direction returned it to the composer.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { pixelValue } from "@/features/terminal/mounted-terminal/agentTerminalLayout";

/** What the reader is doing, and it is the whole of the SGR button code for a wheel. */
export type WheelDirection = "up" | "down";

/**
 * The SGR mouse report for one wheel notch, at one cell.
 *
 * `ESC [ < Cb ; Cx ; Cy M`, with 64 and 65 the wheel's two button codes and the coordinates
 * one-based. There is no matching release: a wheel notch is a press with nothing to let go of,
 * which is why nothing here emits the `m` form.
 *
 * SGR (mode 1006) rather than the legacy X10 encoding because that one adds 32 to each coordinate
 * and puts it in a byte, so it cannot address a column past 223 -- and a report a program cannot
 * read is not refused, it arrives as typed text. The sidecar only reports a pane as taking these
 * when tmux says the program selected SGR; see `mouseReporting` on the terminal descriptor.
 */
export function sgrWheelReport(direction: WheelDirection, column: number, row: number): string {
  return `\u001b[<${direction === "up" ? 64 : 65};${column};${row}M`;
}

/**
 * How far one wheel event asks to move, in rows.
 *
 * Three units arrive here and only one of them is rows. A mouse wheel on this platform reports
 * pixels (`deltaMode` 0) in notches of roughly a hundred, a trackpad reports pixels continuously in
 * ones and twos, and a wheel configured for lines or pages reports those instead. Converting them
 * all to rows here is what lets the caller keep ONE accumulator and send one report per row
 * crossed, rather than one report per event -- which on a trackpad is a request over the network
 * per frame of a flick.
 */
export function wheelRows(
  { deltaY, deltaMode }: { deltaY: number; deltaMode: number },
  cell: { height: number },
  viewportRows: number,
): number {
  if (deltaMode === 1) return deltaY;
  if (deltaMode === 2) return deltaY * viewportRows;
  return cell.height > 0 ? deltaY / cell.height : 0;
}

/** How many reports one event may produce, so a flick cannot become a burst of requests. */
export const MAXIMUM_WHEEL_REPORTS = 8;

/**
 * The whole reports and the fraction left over, from rows accumulated across events.
 *
 * The remainder is carried rather than dropped, because a trackpad's events are each a fraction of
 * a row and dropping them would make a slow scroll do nothing at all. The cap bounds a fast one:
 * what is over it is discarded rather than carried, since a reader who flicked has asked to move
 * far, not to go on moving after they stopped.
 */
export function wheelReports(rows: number): { count: number; direction: WheelDirection; carried: number } {
  const direction: WheelDirection = rows < 0 ? "up" : "down";
  const whole = Math.trunc(rows);
  const count = Math.min(Math.abs(whole), MAXIMUM_WHEEL_REPORTS);
  return { count, direction, carried: count === Math.abs(whole) ? rows - whole : 0 };
}

/** Enough of a terminal to place a pointer in its grid, taken structurally so tests need no xterm. */
export interface WheelGrid {
  /** The terminal's own element: the grid starts inside its padding, not at its border. */
  bounds: { left: number; top: number };
  padding: { left: number; top: number };
  cell: { width: number; height: number };
  columns: number;
  rows: number;
}

/**
 * Which cell the pointer is over, one-based, clamped to the grid.
 *
 * Clamped rather than refused because a wheel event can be delivered with the pointer a pixel
 * outside the element it is over -- on the scrollbar, on the padding, mid-resize -- and a report
 * at the edge cell is the right answer for all of those. A program that routes the wheel by
 * position gets the pane the reader is pointing at; one that ignores position is unaffected.
 */
export function wheelCell(
  point: { clientX: number; clientY: number },
  grid: WheelGrid,
): { column: number; row: number } | null {
  if (grid.cell.width <= 0 || grid.cell.height <= 0) return null;
  const column = Math.floor((point.clientX - grid.bounds.left - grid.padding.left) / grid.cell.width) + 1;
  const row = Math.floor((point.clientY - grid.bounds.top - grid.padding.top) / grid.cell.height) + 1;
  return {
    column: Math.min(Math.max(column, 1), grid.columns),
    row: Math.min(Math.max(row, 1), grid.rows),
  };
}

/**
 * Binds the wheel on one terminal: this buffer on the normal screen, the program on the alternate.
 *
 * Returning false in both arms is deliberate and unchanged. It keeps xterm from also acting on the
 * event -- on the normal screen that would forward a mouse report tmux answers by entering
 * copy-mode, and on the alternate screen xterm's own fallback is to send arrow keys, which in an
 * agent's composer edits the line instead of moving a view.
 *
 * `mouseReporting` is read at the event rather than taken as a value, because it is learned when
 * the terminal opens and this is bound before that, and re-learned from every output chunk after
 * it (see `terminalMouseMode`): a pane that ENTERS fullscreen mid-view sends its own `ESC[?1006h`
 * down the pipe, so the flag is current by the first wheel. Both halves of the alternate-screen
 * condition are load-bearing, and they fail safe in opposite directions. A pane that LEAVES
 * fullscreen while a card is open sends its own `ESC[?1049l` down the pipe, so the buffer type
 * answers correctly even while the descriptor still says the program takes mouse reports, and the
 * wheel goes back to scrolling this buffer.
 */
export function attachTerminalWheel(
  terminal: XtermTerminal,
  {
    scrollLines,
    mouseReporting,
    send,
  }: {
    /** Rows this viewer's own buffer moves per notch, on the normal screen. */
    scrollLines: number;
    mouseReporting: () => boolean;
    send: (data: string) => void;
  },
): void {
  let carried = 0;
  terminal.attachCustomWheelEventHandler((event) => {
    if (terminal.buffer.active.type !== "alternate") {
      terminal.scrollLines(Math.sign(event.deltaY) * scrollLines);
      return false;
    }
    if (!mouseReporting()) return false;
    const element = terminal.element;
    const cell = terminal.dimensions?.css.cell;
    if (!element || !cell) return false;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const at = wheelCell(event, {
      bounds,
      padding: { left: pixelValue(style.paddingLeft), top: pixelValue(style.paddingTop) },
      cell,
      columns: terminal.cols,
      rows: terminal.rows,
    });
    if (!at) return false;
    const report = wheelReports(carried + wheelRows(event, cell, terminal.rows));
    carried = report.carried;
    if (report.count > 0) send(sgrWheelReport(report.direction, at.column, at.row).repeat(report.count));
    return false;
  });
}
