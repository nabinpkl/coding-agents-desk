// Turning what the box holds into what the reader typed.
//
// Three shapes, and the reason there are three is in `tmuxComposer.ts`'s header: nothing
// when the box already reads that way, an append when it is a prefix, and a clear by row
// count and a retype for everything else.

import { hexSend, type TmuxPaneView } from "@/terminal/tmux/tmuxSessions";
import { ATTACHMENT, composerBox, composerText, type ComposerBox } from "@/input/composer/composerBox";
import { meaning } from "@/input/composer/composerPastes";
import type { TmuxComposerRuntime } from "@/input/tmuxComposerRuntime";

/** Kill to the start of the visual row. One per row is what empties the box. */
const KILL_ROW = "\u0015";

const BACKSPACE = "\u007f";
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
const END = "\u0005";
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
 * How long a send is given to reach the screen, and how often the screen is asked.
 *
 * Measured 2026-09-07 against a live pane, ten trials: the pasted text appeared in `capture-pane`
 * between 21ms and 46ms after `send-keys` returned, against a whole request that took about
 * 110ms. The limit is an order of magnitude past the worst of those because it is not a deadline
 * anything depends on -- it is where waiting stops being worth it and the next reader takes its
 * chances, which is the behaviour this module had everywhere before.
 *
 * The interval is smaller than a capture costs, so what actually paces the loop is tmux.
 */
const REDRAW_LIMIT_MS = 400;
const REDRAW_POLL_MS = 5;

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
export function keystrokesFor(
  box: ComposerBox,
  requested: string,
  pasted: (token: string) => string | null = () => null,
  image: (token: string) => string | null = () => null,
): string {
  const { rows } = box;
  // Images this side dropped are diffed by the FILE they are, not by their number, and retyped by
  // dropping that file again. Both halves are needed. By number, a re-drop renumbers the image
  // (`#1` comes back `#2`) and every later push would see a difference and re-drop it again. By
  // name, a retype pastes the characters `[Image #1]`, which Claude keeps as text with no picture
  // behind it -- a two-row message corrected by one backspace went to the model that way.
  const images: string[] = [];
  const current = markImages(composerText(rows), image, images);
  const desired = markImages(requested, image, images);
  // A retype also pastes the WORDS of every paste handle this side knows, for the same reason it
  // re-drops images: the characters `[Pasted text #1]` pasted back are a literal string to Claude,
  // and the nine hundred words they stood for would be gone from the message.
  const retype = (text: string): string => insertion(meaning(text, pasted), images);
  // Both sides read through their paste handles, which is what keeps typing cheap once a draft
  // has grown past the length Claude collapses. `[Pasted text #1]` and the nine hundred
  // characters it stands for share no prefix at all, so without this every further keystroke fell
  // to the correction path below and re-pasted the whole message; through their meaning they
  // share all but the last character, and one keystroke costs one keystroke. It also settles the
  // other direction: a desired text that CARRIES a handle -- a draft the panel adopted from the
  // pane -- now matches the box that is holding it, rather than retyping the characters of its
  // name over the paste it stands for.
  const held = meaning(current, pasted);
  const wanted = meaning(desired, pasted);
  // A box that is only a lower bound cannot be edited incrementally at all: an append would land
  // after whitespace nobody can see, and a backspace count taken from the visible text would rub
  // out one character too few. The clear below needs none of that -- Ctrl+U kills a whole visual
  // row whatever is in it, whether or not the text in it was read correctly.
  if (!box.exact) return END + KILL_ROW.repeat(box.clearPresses) + retype(desired);
  if (held === wanted) return "";
  // Every branch below is written as though the text ends at the cursor. Going to the end is what
  // makes that so, and it is free when the cursor is already there.
  if (held.length > 0 && wanted.startsWith(held)) {
    return END + retype(wanted.slice(held.length));
  }
  // A single row is known exactly, so a correction rubs out only what diverged -- which keeps a
  // backspace in the panel costing a backspace in the pane rather than a whole retype.
  //
  // Counted on the SCREEN text rather than on the meaning, because that is what the presses act
  // on: a handle goes in one press whatever it stands for, so an edit that reaches into a
  // collapsed paste rubs the whole thing out and re-pastes. There is no smaller edit available --
  // Claude offers no way to change the inside of a handle -- so this is the one case that still
  // costs a full push, and it is an edit inside the pasted region rather than typing after it.
  if (rows.length === 1) {
    const shared = sharedPrefix(current, desired);
    const removed = backspacesFor(current.slice(shared));
    return END + BACKSPACE.repeat(removed) + retype(desired.slice(shared));
  }
  return END + KILL_ROW.repeat(box.clearPresses) + retype(desired);
}

/**
 * Where a known image stands while the diff runs: one character to the arithmetic, which is what
 * it costs in the box, and an index into the paths for the retype. Private-use code points, so no
 * reader's text produces one; a stray pair that indexes nothing is pasted as the text it is.
 */
const IMAGE_MARK = /\uE000(\d+)\uE001/g;
const IMAGE_TOKEN = /\[Image #\d+\]/g;

/**
 * Written between the writes of an edit that re-drops an image, and never sent. Claude reads the
 * file a path names before swapping in its token, so text pasted in the same write could land on
 * either side of it; `sendEdit` waits there for the token instead.
 */
const IMAGE_SETTLE = "\uE002";

function markImages(text: string, image: (token: string) => string | null, paths: string[]): string {
  return text.replace(IMAGE_TOKEN, (token) => {
    const path = image(token);
    if (path === null) return token;
    let index = paths.indexOf(path);
    if (index === -1) index = paths.push(path) - 1;
    return `\uE000${index}\uE001`;
  });
}

/** Marked text as keys: words as a paste, and each image as its file dropped on its own. */
function insertion(text: string, paths: readonly string[]): string {
  let keys = "";
  let from = 0;
  for (const mark of text.matchAll(IMAGE_MARK)) {
    const path = paths[Number(mark[1])];
    if (path === undefined) continue;
    keys += paste(text.slice(from, mark.index)) + paste(path) + IMAGE_SETTLE;
    from = mark.index + mark[0].length;
  }
  return keys + paste(text.slice(from));
}

/** The image tokens a box shows, so the one a drop added can be told from those already there. */
export function imageTokens(text: string): string[] {
  return [...text.matchAll(IMAGE_TOKEN)].map((match) => match[0]);
}

/**
 * Binds the image token a drop of `path` just produced, read off the box against `before`.
 *
 * Silent when the reading fails or more than one token appeared, for the reason `bindNewPaste`
 * gives: a wrong binding would re-drop the wrong picture into somebody's message.
 */
export async function bindNewImage(
  pane: string,
  key: string,
  before: readonly string[],
  path: string,
  runtime: Pick<TmuxComposerRuntime, "screen" | "pastes">,
): Promise<void> {
  let after: ComposerBox | null;
  try {
    after = composerBox(await runtime.screen(pane));
  } catch {
    return;
  }
  if (!after) return;
  const fresh = imageTokens(composerText(after.rows)).filter((token) => !before.includes(token));
  if (fresh.length === 1) runtime.pastes.bindImage(key, fresh[0]!, path);
}

/**
 * Sends what `keystrokesFor` computed, in as many writes as the composer can actually apply.
 *
 * A clear and the text replacing it MUST NOT travel in one write, and this is measured rather
 * than defensive. 2026-09-09, on a live pane holding a three-row composer: `Ctrl+E`, nine
 * `Ctrl+U` and a 167-character paste sent as ONE `send-keys` left the box holding the old text
 * with the new text appended to it -- not one kill had taken effect. The identical keys with a
 * 15ms gap before the paste emptied the box and replaced it, as did 40ms. The same burst with a
 * SHORT paste also worked, which is the tell: Claude's renderer is applying one input chunk in
 * one pass, so a paste arriving in the same chunk as the kills is applied to the state the kills
 * had not yet changed. A big paste is what makes the chunk big enough to lose them.
 *
 * Left as one write, that is this module's oldest defect with a new cause: every push pastes the
 * whole draft onto a box it failed to empty, so a reader gets every prefix of their sentence
 * back, joined end to end.
 *
 * Only a CLEAR is split off, and the narrowness is measured rather than cautious. `END` alone
 * changes nothing the paste depends on, and gating it would put a screen read in front of every
 * keystroke a reader types, which is the append path and the common one. The backspace branch was
 * the real question, since it also edits before pasting -- so it was pushed to the largest chunk a
 * single row can produce, 191 backspaces and a 191-character paste in one write, and it landed
 * correctly there and at every smaller size tried. That is a bigger chunk than the nine kills and
 * 167 characters that fail, so the hazard is not chunk size on its own: it is Ctrl+U, which
 * changes the box's ROW COUNT and so the layout the paste is applied against.
 */
export async function sendEdit(
  pane: string,
  key: string,
  keys: string,
  runtime: Pick<TmuxComposerRuntime, "screen" | "send" | "pastes">,
): Promise<void> {
  const encoder = new TextEncoder();
  const at = keys.indexOf(PASTE_START);
  const edit = at === -1 ? keys : keys.slice(0, at);
  let rest = keys;
  if (at !== -1 && edit.includes(KILL_ROW)) {
    await runtime.send(pane, encoder.encode(edit));
    // Waiting on the SCREEN rather than on a sleep, which is the discipline `settle` already uses:
    // it is what keeps this right on a pane that is busy rather than right on the one it was
    // measured against. A clear is done when the box reads empty, and that is a fact this can
    // check, which is the other reason the split is drawn here rather than around every edit.
    await waitFor(pane, runtime, (text) => text.length === 0);
    rest = keys.slice(at);
  }
  // One write per re-dropped image, each ending on that image's path. What follows waits for the
  // token Claude swaps in, and the token is bound to the file so the next edit knows it too.
  const writes = rest.split(IMAGE_SETTLE);
  for (let index = 0; index < writes.length; index += 1) {
    const write = writes[index]!;
    const dropping = index < writes.length - 1;
    const before = dropping ? await tokensInBox(pane, runtime) : [];
    if (write.length > 0) await runtime.send(pane, encoder.encode(write));
    if (!dropping) continue;
    await waitFor(pane, runtime, (text) => imageTokens(text).some((token) => !before.includes(token)));
    await bindNewImage(pane, key, before, lastPasted(write), runtime);
  }
}

async function tokensInBox(pane: string, runtime: Pick<TmuxComposerRuntime, "screen">): Promise<string[]> {
  try {
    const box = composerBox(await runtime.screen(pane));
    return box ? imageTokens(composerText(box.rows)) : [];
  } catch {
    return [];
  }
}

/** The content of the last bracketed paste in `keys`, which for an image write is its path. */
function lastPasted(keys: string): string {
  const start = keys.lastIndexOf(PASTE_START);
  const end = keys.lastIndexOf(PASTE_END);
  return start === -1 || end < start ? "" : keys.slice(start + PASTE_START.length, end);
}

/**
 * Polls the composer until `done` accepts what it holds, or the redraw limit passes.
 *
 * Giving up and carrying on is deliberate: the limit is an order of magnitude past the worst
 * redraw measured, so reaching it means something is wrong that this cannot fix by waiting
 * longer, and the alternative -- refusing to finish an edit -- leaves the box half cleared.
 */
export async function waitFor(
  pane: string,
  runtime: Pick<TmuxComposerRuntime, "screen">,
  done: (text: string) => boolean,
): Promise<void> {
  const deadline = Date.now() + REDRAW_LIMIT_MS;
  while (Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, REDRAW_POLL_MS));
    let view: TmuxPaneView;
    try {
      view = await runtime.screen(pane);
    } catch {
      return;
    }
    const box = composerBox(view);
    if (box && done(composerText(box.rows))) return;
  }
}

/**
 * The text `keys` will insert, which is what a handle Claude then answers with stands for.
 *
 * Read back off the computed keystrokes rather than passed alongside them, because what reaches
 * the box is what the branches above decided to send: an append inserts a suffix and a correction
 * inserts the whole message, and binding a handle to the wrong one of those would be binding it
 * to text that is not in it.
 */
export function insertedText(keys: string): string {
  // An edit that re-drops an image sends the text after the last image as its own write, and that
  // write is the one a new handle can stand for: the image pastes are paths and the text before
  // them went in earlier writes. If one of THOSE collapsed too, `bindNewPaste` sees two new
  // handles and binds neither.
  keys = keys.slice(keys.lastIndexOf(IMAGE_SETTLE) + 1);
  const at = keys.indexOf(PASTE_START);
  if (at === -1) return "";
  const end = keys.indexOf(PASTE_END, at);
  if (end === -1) return "";
  // Back through the escape guard `paste` applies, so what is remembered is the text the reader
  // has rather than the one the pane was given.
  return keys.slice(at + PASTE_START.length, end).replaceAll("\u241b", "\u001b");
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
  return [...text.replaceAll(ATTACHMENT, "\u0000").replaceAll(IMAGE_MARK, "\u0000")].length;
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
  for (const token of [...current.matchAll(ATTACHMENT), ...current.matchAll(IMAGE_MARK)]) {
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
