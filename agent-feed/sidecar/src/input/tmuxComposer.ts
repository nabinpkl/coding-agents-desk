// Reading and driving the composer of a Claude CLI that is running inside a tmux pane.
//
// The screen is the only interface a TUI has. There is no accessibility tree to read and no socket
// that answers "what is in your prompt box", so this reads `capture-pane` and writes `send-keys`,
// and every rule below is a measured property of Claude Code's own renderer (v2.1.263, on a 60
// column pane) rather than an assumption about TUIs in general:
//
//   The box is a rule line, a row beginning `❯ `, zero or more rows indented by two, and a rule.
//   An empty composer still draws it, as `❯ ` alone; a pane mid-redraw draws none of it at all.
//
//   Claude WORD-WRAPS the box itself, emitting a real row per visual line rather than letting the
//   terminal wrap. `capture-pane -J` therefore does not rejoin them -- it joins only terminal-
//   wrapped lines, which was measured on a `cat` pane and does not apply here -- and the space the
//   wrap consumed survives in neither row. So a multi-row composer cannot be reconstructed exactly.
//
//   Ctrl+U kills one VISUAL row, not the whole prompt: a four-row composer needs four of them.
//   That is the one exact lever over a composer whose text cannot be read exactly.
//
// What falls out of those three is the shape of `keystrokesFor`. An exactly-known composer is
// edited incrementally, which is what makes typing feel like typing. An inexactly-known one is
// only ever treated as a HYPOTHESIS: if the guessed text is the start of what is wanted the rest
// is appended, and if the guess was wrong the box is cleared by row count and retyped. A wrong
// guess therefore costs a retype and can never corrupt the pane, which is the property worth
// having -- the pane belongs to whoever is sitting in front of it.

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import { liveTmuxSession } from "../terminal/agentTerminalService.ts";
import { captureTmuxScreen, hexSend, TmuxUnavailable } from "../terminal/tmuxSessions.ts";

/** The character Claude draws at the head of its prompt box. */
const PROMPT = "❯";
/**
 * What separates the marker from the text, and it is not an ordinary space.
 *
 * Claude writes a NO-BREAK space there, measured on a live pane (`\u276f\u00a0make the...`). An
 * ordinary-space strip therefore left one character of padding at the head of every reading, which
 * the panel would then have pushed back into the box as if the reader had typed it.
 */
const GAP = /^[ \u00a0]/;
/** Continuation rows are indented by two ORDINARY spaces, to sit under the text. */
const INDENT = "  ";
/**
 * How much box drawing makes a line a rule.
 *
 * A run rather than a whole-line test, because a rule carries a label: the pane's own title is
 * drawn into the top one. Eight is far more than prose contains and far less than any rule.
 */
const RULE = /─{8}/;

/** Kill to the start of the visual row. One per row is what empties the box. */
const KILL_ROW = "\u0015";
const BACKSPACE = "\u007f";
const CARRIAGE_RETURN = "\r";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * How much text the panel may push into somebody's pane.
 *
 * Smaller than the terminal input route's own 64 KiB ceiling, deliberately: that one bounds a
 * turn sent once, and this one bounds text that is retyped every time a guess misses.
 */
export const MAXIMUM_COMPOSER_BYTES = 16 * 1024;

/**
 * The composer's rows as the screen shows them, or null when the screen shows no composer.
 *
 * Rows rather than text, because the ROW COUNT is exact where the text is not, and it is the row
 * count that clearing depends on.
 */
export function composerRows(screen: string): string[] | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  const head = lastPromptRow(lines);
  if (head === null) return null;
  const rows = [lines[head]!.slice(PROMPT.length).replace(GAP, "")];
  for (let index = head + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (RULE.test(line)) break;
    // Anything not indented into the box has left it. The status line under the bottom rule is
    // indented too, so the rule is what usually stops this; a redraw that dropped the rule would
    // otherwise swallow the whole footer into the composer.
    if (!line.startsWith(INDENT)) break;
    rows.push(line.slice(INDENT.length));
  }
  return rows;
}

/**
 * The prompt row of the LAST composer box on the screen.
 *
 * Anchored on the rule above it rather than on the marker alone. Claude echoes each of the user's
 * own turns into the transcript with the same marker, so a screen holding two turns has three
 * candidate rows and only the last one is a box that can be typed into.
 */
function lastPromptRow(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (!lines[index]!.startsWith(PROMPT)) continue;
    if (!RULE.test(lines[index - 1]!)) continue;
    return index;
  }
  return null;
}

/**
 * The text those rows probably hold.
 *
 * Joined with a space because the wrap Claude performs is a WORD wrap, and the space it broke on
 * survives in neither row. Exact for a single row and a hypothesis for more than one, which is
 * why `wrapped` travels beside it all the way to the panel.
 */
export function composerText(rows: readonly string[]): string {
  return rows.join(" ");
}

/**
 * The bytes that turn a composer holding `rows` into one holding `desired`.
 *
 * Three shapes, in the order they are worth trying:
 *
 *   Nothing, when the box already reads that way. The commonest outcome of all, because the panel
 *   pushes after a debounce and the previous push usually already landed it.
 *
 *   An append, when what is there is the start of what is wanted. This is the typing case, and it
 *   is what makes a keystroke in the panel cost a keystroke in the pane.
 *
 *   A clear and a retype, for everything else: an edit in the middle of the line, a wrapped
 *   composer whose reconstruction was wrong, a pane somebody else has been typing into. Exact
 *   whatever the box holds, because the row count is exact even when the text is not.
 *
 * Inserted text is always a bracketed paste. Claude reads a paste literally, where a bare `/` or
 * `@` at the head of an empty composer opens a menu that then eats what follows it.
 */
export function keystrokesFor(rows: readonly string[], desired: string): string {
  const current = composerText(rows);
  if (current === desired) return "";
  if (current.length > 0 && desired.startsWith(current)) {
    return paste(desired.slice(current.length));
  }
  // A single row is known exactly, so a correction rubs out only what diverged -- which keeps a
  // backspace in the panel costing a backspace in the pane rather than a whole retype.
  if (rows.length === 1) {
    const shared = commonPrefix(current, desired);
    const removed = [...current.slice(shared.length)].length;
    return BACKSPACE.repeat(removed) + paste(desired.slice(shared.length));
  }
  return KILL_ROW.repeat(rows.length) + paste(desired);
}

/** Nothing to insert sends nothing: an empty bracketed paste still makes Claude redraw the box. */
function paste(text: string): string {
  if (text.length === 0) return "";
  // A composer's own text can contain an escape, and it must arrive as one visible character
  // rather than as the start of a sequence the pane will act on. Same guard the terminal prompt
  // route makes, for the same reason.
  return `${PASTE_START}${text.replaceAll("\u001b", "\u241b")}${PASTE_END}`;
}

/** By code point, so an emoji costs one backspace rather than two. */
function commonPrefix(left: string, right: string): string {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared: string[] = [];
  for (let index = 0; index < leftPoints.length && index < rightPoints.length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) break;
    shared.push(leftPoints[index]!);
  }
  return shared.join("");
}

/** Everything the live functions need from tmux, injected so the suite needs no tmux server. */
export interface TmuxComposerRuntime {
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<string>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
}

const LIVE: TmuxComposerRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  screen: captureTmuxScreen,
  send: hexSend,
};

/** What the session's composer is showing, or why it cannot be seen. */
export async function readTmuxComposer(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  const reading = await observe(sessionId, runtime);
  if ("reason" in reading) return unavailable(reading.reason);
  return { text: composerText(reading.rows), reason: null, wrapped: reading.rows.length > 1 };
}

/**
 * Makes the session's composer read `desired`, and reports what it reads afterwards.
 *
 * The screen is read HERE rather than taken from the caller, and that is the whole reason this
 * lives in the sidecar: the person at that keyboard is typing too, so an observation that made a
 * round trip through a browser is old enough to compute the wrong keystrokes from.
 *
 * What comes back is what was asked for, not a fresh read. Reading again immediately afterwards
 * would be a guess at how long Claude takes to redraw, and a read that lands mid-redraw reports no
 * composer at all -- which the panel would show as the sync having failed.
 */
export async function syncTmuxComposer(
  sessionId: string,
  desired: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  const reading = await observe(sessionId, runtime);
  if ("reason" in reading) return unavailable(reading.reason);
  const keys = keystrokesFor(reading.rows, desired);
  if (keys.length > 0) {
    try {
      await runtime.send(reading.pane, new TextEncoder().encode(keys));
    } catch (error) {
      if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
      throw error;
    }
  }
  return { text: desired, reason: null, wrapped: false };
}

/** Presses Return in the pane, which is what makes Claude take the turn. */
export async function submitTmuxComposer(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  let pane: string | null;
  try {
    pane = await runtime.pane(sessionId);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  if (!pane) return unavailable("no-pane");
  try {
    await runtime.send(pane, new TextEncoder().encode(CARRIAGE_RETURN));
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  return { text: "", reason: null, wrapped: false };
}

function unavailable(reason: NonNullable<TmuxComposerState["reason"]>): TmuxComposerState {
  return { text: null, reason, wrapped: false };
}

/** The pane and its composer rows, or the reason there are none. */
async function observe(
  sessionId: string,
  runtime: TmuxComposerRuntime,
): Promise<
  { pane: string; rows: string[] } | { reason: NonNullable<TmuxComposerState["reason"]> }
> {
  let pane: string | null;
  try {
    pane = await runtime.pane(sessionId);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return { reason: "tmux-unavailable" };
    throw error;
  }
  if (!pane) return { reason: "no-pane" };
  let screen: string;
  try {
    screen = await runtime.screen(pane);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return { reason: "tmux-unavailable" };
    throw error;
  }
  const rows = composerRows(screen);
  if (!rows) return { reason: "no-composer" };
  return { pane, rows };
}
