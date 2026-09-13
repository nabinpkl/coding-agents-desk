// The verbs: read a composer, wait for one, type into it, drop an image in it, rename the session
// it belongs to, and press one key at it.
//
// Every one of them takes the pane's turn (`inTurn`) and every one reports a reason rather than
// throwing, because each is the far end of an HTTP request whose caller has to say something
// useful to a reader.

import {
  bytesForRailKey,
  NO_MODIFIERS,
  type RailKey,
  type RailModifiers,
  type TmuxComposerState,
} from "@agentdesk/agent-feed-wire";
import { composerBox, composerText } from "./composerScreen.ts";
import { keystrokesFor, paste, separator, CARRIAGE_RETURN, TAB } from "./composerKeys.ts";
import {
  COALESCE_MS,
  failed,
  inTurn,
  LIVE,
  paneFor,
  readComposerAt,
  sendEdit,
  settle,
  unavailable,
  type TmuxComposerRuntime,
} from "./composerRuntime.ts";


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
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      const box = composerBox(await runtime.screen(pane));
      if (!box) return unavailable("no-composer");
      const keys = keystrokesFor(box, desired);
      if (keys.length > 0) {
        await sendEdit(pane, keys, runtime);
        await settle(pane, composerText(box.rows), runtime);
      }
      // No hint and no menu: whatever Claude was offering, the box now holds what was asked
      // for instead, and the menu under it is redrawn from that. An empty push is the one case
      // where a suggestion comes back, and a push beginning `/` opens a menu -- the watcher
      // reports both a moment later, which is the only reading that is not a guess.
      return { text: desired, hint: null, reason: null, exact: true, commands: [] };
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
      await runtime.send(pane, new TextEncoder().encode(keys));
      // Claude swaps the path for its own `[Image #N]`, so the box always ends up reading
      // differently. Waiting for that is what stops the next push diffing against a box that
      // still shows the moment before the drop.
      await settle(pane, composerText(box.rows), runtime);
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * A space, unless the box is empty.
 *
 * It cannot ask whether the text already ends in one: `capture-pane` strips a row's trailing
 * padding, so a composer ending in a space and one that does not are the same screen. A box that
 * really did end in a space therefore gets a second one, which is the same rounding the append
 * path already lives with and is invisible in a prompt.
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
  return press(sessionId, CARRIAGE_RETURN, { text: "", hint: null, reason: null, exact: true, commands: [] }, runtime);
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
  return press(sessionId, TAB, { text: null, hint: null, reason: null, exact: true, commands: [] }, runtime);
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
    { text: null, hint: null, reason: null, exact: true, commands: [] },
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
 * The pane to type into: the one a live watch is already on, or a fresh resolution.
 *
 * The held one is not verified before it is used. Verifying it would cost the resolution this
 * exists to skip, and the tmux call about to be made is a better check than any preflight: it
 * either lands or it fails, and `failed` turns the failure into an answer.
 */
