// The last row of the screen that has anything on it.
//
// A peek shows the bottom of a screen, which is the line a reader watches when the program draws
// to the bottom -- opencode's status line, a shell's prompt at the end of its output. Claude Code
// does not: in a 40-row pane its box and the mode line under it sit in the top dozen rows, and the
// rest is blank until its transcript scrolls down to fill it. The bottom of that screen is empty
// rows, so a peek that shows the bottom shows nothing. The last DRAWN row is the line a reader is
// there for in both cases.
//
// Of the LIVE screen, not of whatever is scrolled into view. Read from the shown rows, it changed
// on every step of a reader scrolling back through history -- each step brought fuller rows in --
// and each change re-scrolled the peek, so a swipe through history jumped a row up and down
// (measured 2026-10-17, 14px back and forth across one 100px swipe).

import type { IDisposable } from "@xterm/xterm";

/** The part of an xterm `Terminal` this reads: the screen's height, and the buffer behind it. */
export interface DrawnScreen {
  rows: number;
  buffer: {
    active: {
      cursorY: number;
      /** Where the live screen starts in the buffer, below all the history. */
      baseY: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** The live screen's last row with text or the cursor on it, counted from its top. */
export function lastDrawnRow(terminal: DrawnScreen): number {
  const buffer = terminal.buffer.active;
  const cursor = buffer.cursorY;
  for (let row = terminal.rows - 1; row > cursor; row -= 1) {
    if (buffer.getLine(buffer.baseY + row)?.translateToString(true).trim()) return row;
  }
  return cursor;
}

/**
 * Calls `onChange` with the last drawn row whenever it moves, and once now.
 *
 * Read on each render rather than on each write, because a render is when the screen the reader
 * sees changes, and the read is a few dozen rows. Reported only when it moves, so a program
 * redrawing the same frame costs its caller nothing.
 */
export function watchLastDrawnRow(
  terminal: DrawnScreen & { onRender(listener: () => void): IDisposable },
  onChange: (row: number) => void,
): () => void {
  let last = -1;
  const read = (): void => {
    const row = lastDrawnRow(terminal);
    if (row === last) return;
    last = row;
    onChange(row);
  };
  const subscription = terminal.onRender(read);
  read();
  return () => subscription.dispose();
}
