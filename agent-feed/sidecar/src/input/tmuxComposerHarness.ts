// A pane screen, built the way tmux would have drawn it.
//
// Every test here reads a composer out of text, so the fixtures are the fixture: a box
// with its rules, a cursor where tmux would leave one, and the escapes a real capture
// carries. Shared so four suites read the same screen rather than four near-copies.

import {
  type ComposerBox,
  composerPanes,
  composerPastes,
  composerText,
  type TmuxComposerRuntime,
  type TmuxComposerWatchRuntime,
} from "@/input/tmuxComposer";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";

export const RULE = "─".repeat(60);

/** Where the composer's text begins, which is what the module's own `BOX_COLUMN` measures. */
export const BOX_COLUMN = 2;

/** How many lines stand above the prompt row in `screenWith`, so a cursor can be aimed at one. */
export const ABOVE_PROMPT = 3;

/**
 * A pane as tmux answers for one: the screen `capture-pane` returns, and where the cursor is.
 *
 * The cursor defaults to the end of the last row, which is where a reader who has just typed
 * leaves it and what makes the reading exact. `cursor` overrides it with a row and a column
 * counted inside the box, which is how the inexact cases are written.
 */
export function screenWith(
  rows: string[],
  cursor?: { row: number; column: number },
  footer = "⏵⏵ auto mode on (shift+tab to cycle)",
): TmuxPaneView {
  const last = Math.max(rows.length - 1, 0);
  const at = cursor ?? { row: last, column: (rows[last] ?? "").length };
  return {
    screen: [
      "  Some earlier output from the session.",
      "",
      RULE,
      // A no-break space after the marker, which is what a live pane actually writes.
      `❯\u00a0${rows[0] ?? ""}`,
      ...rows.slice(1).map((row) => `  ${row}`),
      RULE,
      "  adprobe  Opus 5 (1M context)                    0 tokens",
      `  ${footer}                 /rc`,
    ].join("\n"),
    cursor: { row: ABOVE_PROMPT + at.row, column: BOX_COLUMN + at.column },
  };
}

/** A hand-written screen, with the cursor put at the end of its last composer row. */
export function paneShowing(screen: string, cursor?: { row: number; column: number }): TmuxPaneView {
  const lines = screen.split("\n");
  const head = lines.findLastIndex((line) => line.replace(/\u001b\[[0-9;]*m/g, "").startsWith("❯"));
  const text = (lines[head] ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(1).replace(/^[ \u00a0]/, "");
  const at = cursor ?? { row: 0, column: text.length };
  return { screen, cursor: { row: head + at.row, column: BOX_COLUMN + at.column } };
}

/**
 * A composer box read exactly, which is what a cursor sitting at the end of the last row means.
 *
 * The inexact case gets its own tests rather than a default, because it is the one that decides
 * between an incremental edit and a retype.
 */
export function held(rows: string[]): ComposerBox {
  return { rows, hint: null, exact: true, commands: [], clearPresses: clearPressesFor(rows) };
}

/** What `composerBox` would compute: enough Ctrl+U for the narrowest pane a reflow could give. */
export function clearPressesFor(rows: readonly string[]): number {
  return Math.max(rows.length, Math.ceil([...composerText(rows)].length / 20));
}

export const KILL = "\u0015";
/** Ctrl+E, which every computed edit leads with so the text really does end at the cursor. */
export const END = "\u0005";

/**
 * What a pane would actually show, given the bytes sent to it.
 *
 * The paste brackets and Ctrl+E are instructions, not characters: a real composer moves its
 * cursor and takes the text between the brackets. A fake that appended them verbatim would show
 * the escape sequences in the box and fail for the wrong reason.
 */
export function typed(keys: string): string {
  return keys.replaceAll(END, "").replaceAll(OPEN, "").replaceAll(CLOSE, "");
}
export const BACKSPACE = "\u007f";
export const OPEN = "\u001b[200~";
export const CLOSE = "\u001b[201~";

export function runtime(overrides: Partial<TmuxComposerRuntime> = {}): TmuxComposerRuntime & {
  sent: string[];
  resolved: number;
} {
  const sent: string[] = [];
  const counted = { resolved: 0 };
  return {
    sent,
    get resolved() {
      return counted.resolved;
    },
    pane: async () => {
      counted.resolved += 1;
      return "agentdesk-1";
    },
    screen: async () => screenWith(["hello"]),
    questionScreen: async () => screenWith(["hello"]),
    send: async (_pane, bytes) => {
      sent.push(new TextDecoder().decode(bytes));
    },
    panes: composerPanes(),
    // The pane name stands in for its identity: these panes are never recreated.
    paneKey: async (pane: string) => pane,
    pastes: composerPastes(),
    ...overrides,
  };
}

export function watchable(initial: string[] = ["hello"]) {
  let notify: (() => void) | null = null;
  const state = {
    rows: initial,
    /** The mode line under the box, which Shift+Tab rewrites without touching the box. */
    footer: "⏵⏵ auto mode on (shift+tab to cycle)",
    pane: "agentdesk-1" as string | null,
    /** How many times the screen was captured, which is the cost this change exists to remove. */
    screens: 0,
    /** How many times the pane was gone looking for, which is the expensive one. */
    resolved: 0,
    /** Reads taken far enough back to see a dialog, which only happen when the box is gone. */
    questionScreens: 0,
    sent: [] as string[],
    watching: false,
  };
  const tmux: TmuxComposerWatchRuntime = {
    pane: async () => {
      state.resolved += 1;
      return state.pane;
    },
    screen: async () => {
      state.screens += 1;
      return screenWith(state.rows, undefined, state.footer);
    },
    // Counted separately, and deliberately not as a screen read: `state.screens` is what the
    // "one read per burst" test measures, and a second capture folded into it would report a
    // cost that is not there. This one is only reached when the composer box is gone, which is
    // what a question dialog does to it, and these panes are showing a box.
    questionScreen: async () => {
      state.questionScreens += 1;
      return screenWith(state.rows);
    },
    send: async (_pane, bytes) => {
      state.sent.push(new TextDecoder().decode(bytes));
    },
    panes: composerPanes(),
    // The pane name stands in for its identity: these panes are never recreated.
    paneKey: async (pane: string) => pane,
    pastes: composerPastes(),
    watch: async (_pane, onOutput) => {
      state.watching = true;
      notify = onOutput;
      return () => {
        state.watching = false;
        notify = null;
      };
    },
  };
  return { state, tmux, write: () => notify?.() };
}

export const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
