// How big the grid is, what a cell measures, and what colour the terminal is painted in.
//
// The font sizes are the argument: a phone reads at a size a desktop does not, and the
// clamp below is why a pinch cannot take the grid past what the pane can hold.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { Dimensions, TerminalSizing } from "@/features/terminal/agentTerminalTypes";

/** A finger this far off where it landed was scrolling, not tapping. */
export const TAP_SLOP_PX = 10;
/** How much scrollback to ask tmux for, and how much to keep. Matches the route's own ceiling. */
export const HISTORY_LINES = 50_000;
/** Rows per wheel notch. Three is what a terminal emulator conventionally scrolls. */
export const WHEEL_LINES = 3;
/**
 * The shape a session is STARTED at when this viewer is not the one that gets to say.
 *
 * A pane that already exists is joined at whatever shape it has, so this only ever applies to a
 * session the panel brings into existence. It matters because a band is a strip: opening a new
 * session from a card created its tmux window at the card's own size -- measured 2026-09-08, two
 * sessions started at 29x13 -- and a session is then stuck in that shape for the agent living in
 * it, however it is looked at afterwards.
 *
 * 80x24 because that is what a terminal is when nobody has said otherwise, including tmux's own
 * default. A surface that DOES claim the shape still opens at its own box, which is the whole
 * point of claiming.
 */
export const DEFAULT_GRID = { columns: 80, rows: 24 };

/**
 * The one import of xterm, shared by every terminal on the page.
 *
 * It stays dynamic so the library is not in the first bundle, but a wall of terminals firing the
 * import together is one question asked ten times. Holding the promise answers it once -- and it
 * also removes a real difference between them: two of those concurrent imports were observed being
 * served different module instances, one of which was not the test's mock.
 */
let xtermModule: Promise<typeof import("@xterm/xterm")> | null = null;

export function loadXterm(): Promise<typeof import("@xterm/xterm")> {
  xtermModule ??= import("@xterm/xterm");
  return xtermModule;
}

/** The size the type is authored at, and what a fit scales away from. */
export const BASE_FONT_SIZE = 13;
/** Above this a small grid in a large pane stops looking like a terminal. */
export const MAXIMUM_FONT_SIZE = 28;
/**
 * Below this the screen is not worth rendering small enough to fit, so it overflows and scrolls.
 *
 * A tmux pane is 80 columns wide by convention, and a card's band on the canvas is a few hundred
 * pixels: fitting the whole width put the type at about nine pixels, which is smaller than any
 * label around it. This is a couple of points below the base size rather than the base itself,
 * because holding out for 13 would push a third of an 80-column screen off the side, where 11
 * costs a much shorter scroll for type that reads.
 *
 * The screen stays COMPLETE either way -- this is the size it stops shrinking at, not a crop. See
 * `fittedFontSize`'s own note on why overflow scrolls here rather than clipping.
 */
export const MINIMUM_FONT_SIZE = 11;
/**
 * The range a reader may zoom through, and the step a press moves.
 *
 * Wider at the bottom than the automatic floor: the floor is what the pane settles at when nobody
 * has said otherwise, and somebody deliberately asking for more of a wide screen on one line is
 * a different request from the pane quietly shrinking under them.
 */
export const TERMINAL_ZOOM = { minimum: 6, maximum: MAXIMUM_FONT_SIZE, step: 1 };

/**
 * One xterm bound to one sidecar terminal: the stream, the input, the size negotiation, the theme.
 *
 * Extracted from the resizable pane when a grid of terminals needed the same protocol without the
 * same chrome. The alternative was a second copy of the checkpoint/output/viewport switch, which is
 * the part where a divergence would be invisible until a screen failed to paint.
 */

/** The sizing values, not the object, so a re-render with the same numbers does not restart. */
export function sizingKey(sizing: TerminalSizing): string {
  return sizing.kind === "fixed" ? `fixed:${sizing.columns}x${sizing.rows}` : "fit";
}


/**
 * How many cells this viewer's box holds.
 *
 * `at` is the cell to measure in, for a caller that must not be answered in the cell currently
 * rendered: a fitted terminal has already shrunk its type to hold an oversized grid, so measuring
 * in that cell returns the oversized grid back. Omitted, it measures what is on screen.
 */
export function proposedDimensions(
  terminal: XtermTerminal,
  mount: HTMLElement,
  at: { width: number; height: number } | null = null,
): Dimensions | null {
  if (mount.clientWidth <= 0 || mount.clientHeight <= 0) return null;
  const cell = at ?? terminal.dimensions?.css.cell;
  if (!cell || cell.width <= 0 || cell.height <= 0) return null;
  const terminalElement = terminal.element;
  if (!terminalElement) return null;
  const style = getComputedStyle(terminalElement);
  const horizontalPadding = pixelValue(style.paddingLeft) + pixelValue(style.paddingRight);
  const verticalPadding = pixelValue(style.paddingTop) + pixelValue(style.paddingBottom);
  const scrollbarWidth = terminal.options.scrollback === 0
    || terminal.options.scrollbar?.showScrollbar === false
    ? 0
    : terminal.options.scrollbar?.width ?? 14;
  return {
    columns: Math.max(2, Math.floor((mount.clientWidth - horizontalPadding - scrollbarWidth) / cell.width)),
    rows: Math.max(1, Math.floor((mount.clientHeight - verticalPadding) / cell.height)),
  };
}

/** A box's padding, in CSS pixels, as one pair. */
export function paddingOf(element: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(element);
  return {
    width: pixelValue(style.paddingLeft) + pixelValue(style.paddingRight),
    height: pixelValue(style.paddingTop) + pixelValue(style.paddingBottom),
  };
}

export function pixelValue(value: string): number {
  return Number.parseInt(value, 10) || 0;
}

export function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64FromBinaryString(value: string): string {
  return btoa(value);
}

export function terminalTheme() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? {
        background: "#0b0e14",
        foreground: "#d8dee9",
        cursor: "#a8c7fa",
        selectionBackground: "#45658d99",
        black: "#1b1d23",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#d4d7dd",
      }
    : {
        background: "#ffffff",
        foreground: "#2a2f38",
        cursor: "#2a6fdb",
        selectionBackground: "#b6d2ff80",
        black: "#383a42",
        red: "#d13b30",
        green: "#3f8f3c",
        yellow: "#9a6a00",
        blue: "#2a6fdb",
        magenta: "#9b2bb0",
        cyan: "#0a7d8c",
        white: "#a0a1a7",
      };
}
