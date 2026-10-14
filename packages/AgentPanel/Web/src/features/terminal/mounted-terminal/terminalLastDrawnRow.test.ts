import { expect, test } from "vitest";
import { lastDrawnRow, watchLastDrawnRow } from "@/features/terminal/mounted-terminal/terminalLastDrawnRow";

/** A screen of `rows` rows over `scrolled` rows of history, drawn from `lines`, the cursor at `cursorY`. */
function screen(lines: string[], { rows = 8, cursorY = 0, scrolled = 0 } = {}) {
  let render: (() => void) | null = null;
  const fake = {
    rows,
    buffer: {
      active: {
        cursorY,
        viewportY: scrolled,
        getLine: (index: number) => {
          const text = lines[index];
          return text === undefined ? undefined : { translateToString: () => text };
        },
      },
    },
    onRender: (listener: () => void) => {
      render = listener;
      return { dispose: () => { render = null; } };
    },
  };
  return { fake, render: () => render?.() };
}

// Claude Code's shape: its box and mode line near the top of a tall pane, blank rows under them.
test("a screen drawn near its top ends at its last line of text, not at its last row", () => {
  const { fake } = screen(["╭───╮", "│ > │", "╰───╯", "  ⏵⏵ don't ask on", "", "", "", ""], { cursorY: 1 });
  expect(lastDrawnRow(fake)).toBe(3);
});

// opencode's shape, and a shell's at the end of its output: drawn to the bottom, so unchanged.
test("a screen drawn to its bottom ends at its bottom", () => {
  const { fake } = screen(["a", "", "", "", "", "", "", "status"], { cursorY: 2 });
  expect(lastDrawnRow(fake)).toBe(7);
});

test("the cursor counts as drawn, so a fresh prompt on a blank line is still shown", () => {
  const { fake } = screen(["$ ls", "x", "", "", "", "", "", ""], { cursorY: 2 });
  expect(lastDrawnRow(fake)).toBe(2);
});

test("rows are counted from the top of what is shown, past any history above it", () => {
  const { fake } = screen(["old", "old", "top", "drawn", "", "", "", "", "", ""], { scrolled: 2 });
  expect(lastDrawnRow(fake)).toBe(1);
});

test("the watch reports a move, and stays quiet while the same frame is redrawn", () => {
  const lines = ["a", "", "", "", "", "", "", ""];
  const { fake, render } = screen(lines);
  const seen: number[] = [];
  const stop = watchLastDrawnRow(fake, (row) => seen.push(row));
  render();
  lines[4] = "more";
  render();
  render();
  stop();
  lines[6] = "after";
  render();
  expect(seen).toEqual([0, 4]);
});
