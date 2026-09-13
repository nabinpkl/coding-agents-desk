// Turning "the box should say this" into the keys that make it say it.
//
// Split from the reading half (`composerScreen.ts`) because the two answer different questions and
// only one of them touches a terminal. Everything here is pure: given a box and a desired string
// it returns bytes, and it is the same bytes every time, which is what makes the hazardous cases
// -- an apostrophe, a newline, an emoji -- testable without a pane.
//
// The rule the whole file turns on is in `keystrokesFor`: an exactly-known box is edited
// incrementally, and an inexactly-known one is treated as a HYPOTHESIS. A wrong guess costs a
// retype and can never corrupt the pane.

import { ATTACHMENT, composerText, type ComposerBox } from "./composerScreen.ts";

/** Kill to the start of the visual row. One per row is what empties the box. */
export const KILL_ROW = "\u0015";
export const BACKSPACE = "\u007f";
export const CARRIAGE_RETURN = "\r";
/** What accepts Claude's suggestion. Measured: the row comes back with no faint run at all. */
export const TAB = "\t";
/**
 * Ctrl+E, which puts the cursor after the last character of the WHOLE box.
 *
 * Every edit this module computes assumes the text ends at the cursor: a backspace bites to the
 * left of it, a paste lands at it, and one Ctrl+U per row clears the box only if the cursor starts
 * on the last of them. Nothing made that true, and a reader breaks it by tapping into the middle
 * of their own sentence to fix a typo -- or, now, by pressing the key rail's own arrows. So the
 * assumption is made true rather than assumed, by going to the end first.
 *
 * It is Ctrl+E rather than End, and that difference IS the bug this replaces. Measured 2026-09-08
 * on a live pane against tmux's own `#{cursor_x}`/`#{cursor_y}` rather than inferred from the
 * text: both spellings of End (`ESC [ F` and `ESC O F`) are end-of-VISUAL-LINE. On a wrapped box
 * with the cursor on the first row they left it at the wrap boundary, so the row-count clear then
 * killed upward from the middle and every row BELOW the cursor survived -- a box cleared that way
 * came back still holding `the end`, and the paste that followed landed on top of it. The reader
 * sees their words twice. Ctrl+E from that same position reached the true end of the buffer, and
 * the identical clear emptied the box.
 *
 * The note that used to stand here said Ctrl+E does not move Claude's cursor. That was measured on
 * a single-row box, where end-of-line and end-of-buffer are the same column and no key can be told
 * apart from any other.
 */
export const END = "\u0005";
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/**
 * How much text the panel may push into somebody's pane.
 *
 * Smaller than the terminal input route's own 64 KiB ceiling, deliberately: that one bounds a
 * turn sent once, and this one bounds text that is retyped every time a guess misses.
 */
export const MAXIMUM_COMPOSER_BYTES = 16 * 1024;

/**
 * The bytes that turn a composer holding `rows` into one holding `desired`.
 *
 * Four shapes, in the order they are worth trying:
 *
 *   A clear and a retype, when the reading is not exact -- which is checked FIRST, because every
 *   other branch here is arithmetic on a text that would then be missing characters.
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
export function keystrokesFor(box: ComposerBox, desired: string): string {
  const { rows } = box;
  const current = composerText(rows);
  // A box that is only a lower bound cannot be edited incrementally at all: an append would land
  // after whitespace nobody can see, and a backspace count taken from the visible text would rub
  // out one character too few. The clear below needs none of that -- Ctrl+U kills a whole visual
  // row whatever is in it, whether or not the text in it was read correctly.
  if (!box.exact) return END + KILL_ROW.repeat(box.clearPresses) + paste(desired);
  if (current === desired) return "";
  // Every branch below is written as though the text ends at the cursor. Going to the end is what
  // makes that so, and it is free when the cursor is already there.
  if (current.length > 0 && desired.startsWith(current)) {
    return END + paste(desired.slice(current.length));
  }
  // A single row is known exactly, so a correction rubs out only what diverged -- which keeps a
  // backspace in the panel costing a backspace in the pane rather than a whole retype.
  if (rows.length === 1) {
    const shared = sharedPrefix(current, desired);
    const removed = backspacesFor(current.slice(shared));
    return END + BACKSPACE.repeat(removed) + paste(desired.slice(shared));
  }
  return END + KILL_ROW.repeat(box.clearPresses) + paste(desired);
}


/** Nothing to insert sends nothing: an empty bracketed paste still makes Claude redraw the box. */
export function paste(text: string): string {
  if (text.length === 0) return "";
  // A composer's own text can contain an escape, and it must arrive as one visible character
  // rather than as the start of a sequence the pane will act on. Same guard the terminal prompt
  // route makes, for the same reason.
  return `${PASTE_START}${text.replaceAll("\u001b", "\u241b")}${PASTE_END}`;
}

/**
 * How many backspaces rub out `text`, which is not how long it is.
 *
 * Each attachment token goes in one press; everything else goes by code point, so an emoji costs
 * one backspace rather than two.
 */
function backspacesFor(text: string): number {
  return [...text.replaceAll(ATTACHMENT, "\u0000")].length;
}

/**
 * How much of `current` to keep, which is the shared prefix moved back off any token it split.
 *
 * A prefix that ends inside a token would have the rest of that token counted character by
 * character and then deleted whole, taking the neighbours with it. Backing up to the token's start
 * costs one extra press and cannot be wrong.
 */
function sharedPrefix(current: string, desired: string): number {
  let shared = commonPrefix(current, desired).length;
  for (const token of current.matchAll(ATTACHMENT)) {
    const start = token.index;
    if (shared > start && shared < start + token[0].length) shared = start;
  }
  return shared;
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


export function separator(box: ComposerBox): string {
  return composerText(box.rows).length === 0 ? "" : " ";
}

/**
 * What a rename attempt did, or the reason it did nothing.
 *
 * `composer-busy` is the one reason that is not a failure: somebody has text in that box, and
 * renaming would type a command into the middle of what they were writing.
 */
