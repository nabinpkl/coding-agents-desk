// Reading and driving the composer of a Claude CLI that is running inside a tmux pane.
//
// The screen is the only interface a TUI has. There is no accessibility tree to read and no socket
// that answers "what is in your prompt box", so this reads `capture-pane` and writes `send-keys`,
// and every rule below is a measured property of Claude Code's own renderer (v2.1.263, on a 60
// column pane) rather than an assumption about TUIs in general:
//
//   The box is a rule line, a row beginning `❯ `, zero or more rows indented by two, and a rule.
//   An empty composer still draws it, as `❯ ` alone.
//
//   TWO things draw none of it, and they are not the same thing to whoever is reading the panel.
//   A pane mid-redraw is one, and it is over in milliseconds: measured 2026-09-09 across a burst
//   of `resize-window` calls, polling every ~5ms, the box was missing for exactly one poll -- so
//   that window is at most ~5ms and the measurement cannot say how much less. `COALESCE_MS` below
//   is what keeps the watcher out of it: ten resizes through the live watcher reported none of
//   them. The other is a DIALOG -- `/model`, `/resume`, a permission prompt -- which replaces the
//   box with an option list and stands until somebody answers it IN THE PANE. Measured the same
//   day through the live watcher: `/model` reported `no-composer` for the full fourteen seconds
//   the picker was open, clearing on Escape.
//
//   That second one is the common producer of `no-composer` and the reason the panel's own
//   wording for it must not promise the composer is coming back. Both reasons look identical
//   here, and deliberately: the box is genuinely not on the screen either way, and this module
//   reports the absence rather than guessing at a cause it cannot see.
//
//   TELLING THEM APART FROM TMUX WAS TRIED, AND DOES NOT WORK. `#{cursor_flag}` looks like the
//   answer, because Claude hides the cursor when there is nothing to type into: measured
//   2026-09-09, it reads 1 at a normal composer and 0 for as long as a `/model` picker, a
//   `/resume` list or a `Do you want to proceed?` prompt is up. But it reads 0 during a redraw
//   too. Each repaint is bracketed by `ESC[?25l` ... `ESC[?25h`, and the whole screen -- both
//   rules and every marker -- is erased and rewritten INSIDE that bracket (measured across
//   seven resizes: 30 erase-lines, 2 rules and 3 markers per bracket). So a capture taken mid-
//   redraw sees exactly what a dialog shows it. The one thing the flag does separate is a
//   session that exited: a shell prompt keeps the cursor shown, and reads 1 with no box.
//
//   Nothing else in tmux carries it either. Its vocabulary is the cursor's position, shape and
//   colour and tmux's OWN modes; there is no widget model to ask, because a pane is a cell grid.
//   Claude publishes no marker of its own: a census of every escape sequence it emits across a
//   start, a turn and a shutdown found cursor moves, SGR, erase-line, OSC 8 hyperlinks,
//   bracketed paste, focus and theme reporting, and the Kitty keyboard protocol -- no OSC 133
//   semantic prompt marking, no private payload, and no alternate screen, since it draws inline.
//   If that ever changes, OSC 133 is what would replace this parser outright.
//
//   Claude WORD-WRAPS the box itself, emitting a real row per visual line rather than letting the
//   terminal wrap. `capture-pane -J` therefore does not rejoin them -- it joins only terminal-
//   wrapped lines, which was measured on a `cat` pane and does not apply here -- and the space the
//   wrap consumed survives in neither row. So a multi-row composer cannot be reconstructed exactly.
//
//   Ctrl+U kills one VISUAL row, not the whole prompt: a four-row composer needs four of them.
//   That is the one exact lever over a composer whose text cannot be read exactly.
//
//   A TRAILING SPACE is invisible in the capture and visible in the cursor. tmux pads every
//   captured row out to the pane width, so a box holding `abc ` and one holding `abc` come back as
//   the same string; `#{cursor_x}` reported 6 against 5 for exactly that pair. So the reading is
//   only complete where the cursor is, and `ComposerBox.exact` says whether it was.
//
//   A row that holds NOTHING is still one of the box's rows. Text ending exactly at a wrap
//   boundary draws an empty row and parks the caret on it, so the box is one row taller than the
//   rows with text in them -- measured 2026-09-09 at 60 columns, four drawn against three read.
//   The closing rule is what says where the box ends; the indent cannot, because tmux pads that
//   row to the pane width and it comes back trimmed to nothing.
//
//   The one bracketed edit that must NOT travel with the text it is replacing is the CLEAR. See
//   `sendEdit`, which carries the measurement.
//
//   An EMPTY box is not always empty-looking. Claude draws a suggestion in it, and the only thing
//   separating that from typed words is that it is FAINT. So the screen is read with its colour
//   on, which is the one place an escape sequence here is content rather than noise. The hint
//   travels beside the text rather than as part of it, and Tab is what fills it in -- measured:
//   after a Tab the same row comes back with no faint run at all.
//
// What falls out of those three is the shape of `keystrokesFor`. An exactly-known composer is
// edited incrementally, which is what makes typing feel like typing. An inexactly-known one is
// only ever treated as a HYPOTHESIS: if the guessed text is the start of what is wanted the rest
// is appended, and if the guess was wrong the box is cleared by row count and retyped. A wrong
// guess therefore costs a retype and can never corrupt the pane, which is the property worth
// having -- the pane belongs to whoever is sitting in front of it.

import {
  bytesForRailKey,
  NO_MODIFIERS,
  type RailKey,
  type RailModifiers,
  type TmuxComposerState,
} from "@agentdesk/agent-feed-wire";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";
import { composerBox, composerText, type ComposerBox } from "@/input/composer/composerBox";
import {
  bindNewImage,
  CARRIAGE_RETURN,
  imageTokens,
  insertedText,
  keystrokesFor,
  paste,
  sendEdit,
  TAB,
} from "@/input/composer/composerKeystrokes";
import { pasteTokens } from "@/input/composer/composerPastes";
import { inTurn, settle } from "@/input/tmuxComposerPanes";
import {
  COALESCE_MS,
  LIVE,
  readComposerAt,
  unavailable,
  type TmuxComposerRuntime,
} from "@/input/tmuxComposerRuntime";

// Re-exported because this is the address the routes and the tests already have, and the
// parts below are how the composer is built rather than what it offers.
export { composerBox, composerText, type ComposerBox } from "@/input/composer/composerBox";
export { keystrokesFor, MAXIMUM_COMPOSER_BYTES } from "@/input/composer/composerKeystrokes";
export {
  composerPastes,
  meaning,
  pasteTokens,
  type ComposerPasteStore,
} from "@/input/composer/composerPastes";
export { composerPanes, type TmuxComposerPanes } from "@/input/tmuxComposerPanes";
export {
  liveTmuxComposerRuntime,
  observeTmuxComposer,
  readComposerAt,
  type TmuxComposerListener,
  type TmuxComposerRuntime,
  type TmuxComposerWatchRuntime,
} from "@/input/tmuxComposerRuntime";

export async function syncTmuxComposer(
  sessionId: string,
  desired: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      const box = composerBox(await runtime.screen(pane));
      if (!box) return unavailable("no-composer");
      const before = composerText(box.rows);
      const key = await runtime.paneKey(pane);
      const keys = keystrokesFor(
        box,
        desired,
        (token) => runtime.pastes.textFor(key, token),
        (token) => runtime.pastes.imageFor(key, token),
      );
      if (keys.length > 0) {
        await sendEdit(pane, key, keys, runtime);
        await settle(pane, before, runtime);
        await bindNewPaste(pane, key, before, insertedText(keys), runtime);
      }
      // No hint and no menu: whatever Claude was offering, the box now holds what was asked
      // for instead, and the menu under it is redrawn from that. An empty push is the one case
      // where a suggestion comes back, and a push beginning `/` opens a menu -- the watcher
      // reports both a moment later, which is the only reading that is not a guess.
      return { text: desired, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] };
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * Puts the image at `path` into the session's composer, by pasting the path the way a drop does.
 *
 * A bare paste rather than a `sync`, and the difference matters: Claude's paste handler reads the
 * text of THIS paste to decide whether it is looking at a file path, so the path has to arrive on
 * its own. A sync that appended it to the box would send exactly the same bytes while the box
 * agrees, and on the one push where it does not, would clear and retype the whole composer as a
 * single paste -- which parses as one image plus everything else as text, in the wrong order.
 *
 * The separating space is sent OUTSIDE the paste, as an ordinary keystroke. Measured: a paste of
 * " /tmp/x.png" splits on the space that precedes the slash and the empty half is dropped, so a
 * space put inside the paste never reaches the box at all.
 *
 * What the box then holds is not guessed at. Claude replaces the path with its own `[Image #N]`,
 * which is a different string from the one sent, so the watcher reads the pane and says.
 */
export async function dropTmuxComposerImage(
  sessionId: string,
  path: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      const box = composerBox(await runtime.screen(pane));
      if (!box) return unavailable("no-composer");
      const keys = separator(box) + paste(path);
      const before = composerText(box.rows);
      await runtime.send(pane, new TextEncoder().encode(keys));
      // Claude swaps the path for its own `[Image #N]`, so the box always ends up reading
      // differently. Waiting for that is what stops the next push diffing against a box that
      // still shows the moment before the drop.
      await settle(pane, before, runtime);
      // And the token it swapped in is bound to the file, so an edit that later has to retype
      // across it drops the file again rather than typing the token's name.
      await bindNewImage(pane, await runtime.paneKey(pane), imageTokens(before), path, runtime);
      return { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] };
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * Remembers what the handle Claude just answered with stands for, when it answered with one.
 *
 * The one moment this can be learned. Claude collapses a paste as it takes it and never says so:
 * the text goes into a table inside that process, the box gets `[Pasted text #7]`, and nothing
 * afterwards connects the two. The side that did the pasting is the only side that ever holds
 * both halves, and only for as long as this call.
 *
 * Told apart by the handle being NEW rather than by the push having been long enough to collapse.
 * The threshold is Claude's and could move under us -- measured at 801 characters and four lines
 * today -- where "the box gained a handle it did not have, and we are the ones who just pasted"
 * stays true whatever the number is.
 *
 * Silent when the reading fails or when more than one handle appeared. A binding that might be
 * wrong is worse than none: a wrong one is pasted back into somebody's session as though it were
 * their words, where a missing one costs a re-paste and a preview that says it is not held.
 */
async function bindNewPaste(
  pane: string,
  key: string,
  before: string,
  inserted: string,
  runtime: TmuxComposerRuntime,
): Promise<void> {
  if (inserted.length === 0) return;
  const had = new Set(pasteTokens(before).map((found) => found.token));
  let after: ComposerBox | null;
  try {
    after = composerBox(await runtime.screen(pane));
  } catch {
    return;
  }
  if (!after) return;
  const fresh = pasteTokens(composerText(after.rows)).filter((found) => !had.has(found.token));
  if (fresh.length !== 1) return;
  runtime.pastes.bind(key, fresh[0]!.token, inserted);
}

/**
 * A space, unless the box is empty.
 *
 * It cannot ask whether the text already ends in one: `capture-pane` strips a row's trailing
 * padding, so a composer ending in a space and one that does not are the same screen. A box that
 * really did end in a space therefore gets a second one, which is the same rounding the append
 * path already lives with and is invisible in a prompt.
 */
function separator(box: ComposerBox): string {
  return composerText(box.rows).length === 0 ? "" : " ";
}

/**
 * What a rename attempt did, or the reason it did nothing.
 *
 * `composer-busy` is the one reason that is not a failure: somebody has text in that box, and
 * renaming would type a command into the middle of what they were writing.
 */
export type SessionRenameOutcome =
  | { renamed: true }
  | { renamed: false; reason: TmuxComposerState["reason"] | "composer-busy" };

/**
 * Renames the session by running Claude's own `/rename`, in the pane the session is running in.
 *
 * The CLI is asked rather than its transcript written, because `/rename` changes BOTH of a
 * session's names -- it writes the `custom-title` record the panel reads AND the `agent-name`
 * record, and updates the process's registry `name`, which is the address `ListAgents` prints and
 * `SendMessage` uses. Appending a record from outside can only ever move the first of those, so a
 * session renamed that way keeps answering to its old name everywhere that matters for discovery.
 * It also means no second writer on a file the CLI owns.
 *
 * Sent as a bracketed paste, the same way every other insertion in this module goes: measured
 * 2026-09-07 that Claude dispatches a slash command that arrives pasted, so this avoids the
 * command menu that a typed leading `/` opens without giving up the dispatch.
 *
 * Runs even while the session is mid-turn, and does not interrupt it: measured against a session
 * counting to forty, which finished its count with the new name already on it.
 *
 * Refused when the composer holds anything, because the only way to type a command into a box is
 * to type it where the reader was writing.
 */
export async function renameTmuxSession(
  sessionId: string,
  title: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<SessionRenameOutcome> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return { renamed: false, reason: "no-pane" };
      const box = composerBox(await runtime.screen(pane));
      if (!box) return { renamed: false, reason: "no-composer" };
      if (composerText(box.rows).length > 0) return { renamed: false, reason: "composer-busy" };
      const encoder = new TextEncoder();
      // One send, not two: the command and the Return travel together so nothing can be typed
      // between them into the box this just checked was empty.
      const keys = keystrokesFor(box, `/rename ${title}`);
      await runtime.send(pane, encoder.encode(keys + CARRIAGE_RETURN));
      return { renamed: true };
    } catch (error) {
      const state = failed(sessionId, error, runtime);
      return { renamed: false, reason: state.reason };
    }
  });
}

/** Presses Return in the pane, which is what makes Claude take the turn. */
export async function submitTmuxComposer(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(sessionId, CARRIAGE_RETURN, { text: "", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] }, runtime);
}

/**
 * Presses Tab, which is how Claude's own suggestion becomes text in its box.
 *
 * Deliberately a key rather than a push of the hint's text. What the suggestion means, and what
 * accepting it does, belong to Claude: pushing the words back would be this module deciding that
 * accepting is the same as typing them, which is true only until it is not.
 *
 * What the box then holds is not guessed at here. The watcher reads the pane and says.
 */
export async function acceptTmuxComposerHint(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(sessionId, TAB, { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] }, runtime);
}

/**
 * One key rail press into the session's pane.
 *
 * The composer band grew this for the same reason the terminal has a rail: a phone keyboard has no
 * Esc, no Tab, no Ctrl and no arrows, and those are most of how Claude's own prompt box is driven.
 * Reading a suggestion and pressing Tab already had a route of its own; everything else did not.
 *
 * The key arrives NAMED rather than as bytes. A route that took bytes would be a second way to
 * write anything at all into somebody's pane, and it would put the mapping from key to sequence in
 * whichever caller happened to send it -- so `bytesForRailKey` lives on the wire and both sides
 * read the same one.
 *
 * What the box then holds is not guessed at. An arrow moves a cursor and Escape may clear the
 * whole thing, neither of which this can predict, so the watcher reads the pane and says.
 */
export async function pressTmuxComposerKey(
  sessionId: string,
  key: RailKey,
  held: RailModifiers = NO_MODIFIERS,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(
    sessionId,
    bytesForRailKey(key, held),
    { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] },
    runtime,
  );
}

/**
 * One key into the session's pane, with the state to report when it lands.
 *
 * Queued behind whatever else is driving this box, but deliberately WITHOUT the redraw wait the
 * pushes do, because it would cost a screen read and this path is the one that must work when the
 * screen cannot be read at all -- a pane mid-redraw draws no composer, and a reader who has
 * pressed Return should not be told the session has no composer because of when they pressed it.
 *
 * What it gives up by not waiting is small enough to name. A push arriving before Return's redraw
 * reads the box as it was and computes backspaces for text that has already gone, and a backspace
 * on an empty composer does nothing -- so the retype lands correctly anyway. Tab is the one with a
 * real gap: the suggestion it takes is not on screen yet, so a push in that window can append to
 * it. The panel does not push there, it waits for the watcher to say what the box now holds.
 */
async function press(
  sessionId: string,
  key: string,
  landed: TmuxComposerState,
  runtime: TmuxComposerRuntime,
): Promise<TmuxComposerState> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      await runtime.send(pane, new TextEncoder().encode(key));
      return landed;
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * Waits for a session's composer to appear, which is how a just-started one says it is up.
 *
 * A pane exists from the instant tmux makes it, and the CLI in it does not: it starts, reads its
 * settings and hooks, and loads whatever transcript it was pointed at, which for a fork of a long
 * session is seconds rather than milliseconds. Until the box is drawn there is nothing to type
 * into and nothing to read, and every refusal in this module would name the wrong cause.
 *
 * Answers false rather than throwing, because "it never came up" is an outcome the caller reports
 * rather than an error in the asking.
 */
export async function awaitComposer(
  sessionId: string,
  limitMs: number,
  runtime: TmuxComposerRuntime = LIVE,
  wait: (ms: number) => Promise<void> =
    (ms) => new Promise<void>((done) => setTimeout(done, ms)),
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const pane = await paneFor(sessionId, runtime).catch(() => null);
    if (pane) {
      const state = await readComposerAt(pane, runtime).catch(() => null);
      if (state && state.reason === null) return true;
    }
    if (Date.now() - started >= limitMs) return false;
    await wait(COALESCE_MS);
  }
}

/**
 * The pane to type into: the one a live watch is already on, or a fresh resolution.
 *
 * The held one is not verified before it is used. Verifying it would cost the resolution this
 * exists to skip, and the tmux call about to be made is a better check than any preflight: it
 * either lands or it fails, and `failed` turns the failure into an answer.
 */
export async function paneFor(sessionId: string, runtime: TmuxComposerRuntime): Promise<string | null> {
  return runtime.panes.get(sessionId) ?? await runtime.pane(sessionId);
}

/**
 * A tmux failure, turned into a reason -- and a held pane that failed is dropped on the way.
 *
 * This is where a session that ended is found out. A watch does not notice: the pipe simply goes
 * quiet, and tmux takes the session down with the process that was running in it. So the first
 * push after that reports `tmux-unavailable`, truthfully -- tmux really did refuse -- and drops
 * the pane, and the one after it resolves, finds no live process, and says `no-pane`, which is
 * what the reader needs to be told.
 */
function failed(
  sessionId: string,
  error: unknown,
  runtime: TmuxComposerRuntime,
): TmuxComposerState {
  if (!(error instanceof TmuxUnavailable)) throw error;
  runtime.panes.forget(sessionId);
  return unavailable("tmux-unavailable");
}

