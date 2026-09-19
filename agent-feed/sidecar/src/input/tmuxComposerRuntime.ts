// What the composer functions need from tmux, injected so a test never touches a pane,
// and the watch that reports a pane's box as it changes.

import type {
  TmuxComposerEnvelope,
  TmuxComposerState,
  TmuxQuestionState,
} from "@agentdesk/agent-feed-wire";
import {
  captureTmuxPaneView,
  captureTmuxQuestionView,
  hexSend,
  TmuxUnavailable,
  type TmuxPaneView,
} from "@/terminal/tmux/tmuxSessions";
import { liveTmuxSession } from "@/terminal/agentTerminalService";
import { composerBox, composerText, type ComposerBox } from "@/input/composerBox";
import { composerPanes, type TmuxComposerPanes } from "@/input/tmuxComposerPanes";
import { questionDialog } from "@/input/question/questionDialog";
import { questionStateFrom } from "@/input/question/questionMirrorState";

/** Everything the live functions need from tmux, injected so the suite needs no tmux server. */
export interface TmuxComposerRuntime {
  /**
   * Finds which tmux session a Claude session is running in, from scratch.
   *
   * The expensive call, and the reason `panes` exists. Reached only by a watch opening, or by a
   * push that arrives with nothing watching.
   */
  pane: (sessionId: string) => Promise<string | null>;
  /**
   * What the pane is showing AND where its cursor is, which is one question rather than two.
   *
   * The cursor is what makes the reading exact: tmux pads a captured row to the pane width, so a
   * trailing space is invisible in the text and visible in the column. Splitting these into two
   * calls would also be splitting them in TIME, and the answer would be a screen from one instant
   * beside a cursor from another.
   */
  screen: (pane: string) => Promise<TmuxPaneView>;
  /**
   * The same pane, read far enough back to take in a question dialog taller than it.
   *
   * A second capture rather than a wider `screen`, because the two readers want different things
   * from one pane. The composer reads a box the screen owns, and history would let an older paint
   * match it. A dialog is not bounded by the pane at all: four options with real descriptions put
   * its opening rule and question text above the top of the screen, and all of it is what the
   * dialog is found by.
   */
  questionScreen: (pane: string) => Promise<TmuxPaneView>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
  panes: TmuxComposerPanes;
}

/** What watching additionally needs: a way to be told the pane wrote something. */
export interface TmuxComposerWatchRuntime extends TmuxComposerRuntime {
  /**
   * Asks to be told when the pane writes, until the returned function is called.
   *
   * Not implemented in this module, and that is structural rather than shy: a pane has exactly
   * one pipe and the terminal service owns it, so a second one set here would not add a listener,
   * it would silently replace that service's. `server.ts` wires this to the service's own.
   */
  watch: (pane: string, onOutput: () => void) => Promise<() => void>;
}

/**
 * The shortest gap between two screen reads, and the delay after output before the first.
 *
 * A pane writes in bursts -- one keystroke redraws the box, one turn redraws everything -- so
 * reading per burst would read many times for one change. Trailing rather than leading, so the
 * read sees the burst finished rather than halfway through: a capture taken mid-redraw is the
 * `no-composer` case, which would show as the mirror blinking out and back on every keystroke.
 *
 * At 150ms a pane being typed into costs at most seven reads a second and an idle one costs
 * NONE, which is the whole point of this being driven by output instead of by a clock.
 */
export const COALESCE_MS = 150;

export const LIVE: TmuxComposerRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  screen: captureTmuxPaneView,
  questionScreen: captureTmuxQuestionView,
  send: hexSend,
  // One registry for the process, so a watch opened through the routes is visible to a push that
  // took the default runtime. Two would be two answers to one question.
  panes: composerPanes(),
};

/** The live runtime, given the pane signal only the terminal service can supply. */
export function liveTmuxComposerRuntime(
  watch: TmuxComposerWatchRuntime["watch"],
): TmuxComposerWatchRuntime {
  return { ...LIVE, watch };
}

/** Where a watcher's reports go, and how it says there will be no more of them. */
export interface TmuxComposerListener {
  /**
   * One reading of the pane: the box, and the question dialog standing in front of it.
   *
   * Both from one capture pass rather than two subscriptions, because they are two questions about
   * one screen at one instant. A panel that asked separately would be holding a composer from one
   * moment beside a dialog from another.
   */
  onState: (envelope: TmuxComposerEnvelope) => void;
  /**
   * There is nothing to watch, so nothing further will be said.
   *
   * Separate from a reason on the state because it is about the WATCH, not the composer: it means
   * ask again later if you still care, and the caller decides how much later. An `EventSource`
   * decides by reconnecting, which is why nothing here holds a retry timer.
   */
  onEnd: () => void;
}

/**
 * Reports what the session's composer holds, and again whenever it CHANGES, until stopped.
 *
 * Driven by the pane's own output rather than by a timer. That is the difference between a mirror
 * that costs a `capture-pane` every second forever and one that costs nothing at all while
 * nobody is typing -- which is most of the time, and exactly the state a composer sits in.
 *
 * Only differences are reported. A redraw that leaves the box alone -- which is nearly every
 * redraw, since a working session is writing above its composer, not into it -- is read and
 * dropped here rather than sent to every panel watching.
 *
 * The pane is resolved ONCE, here, and then held for everything that follows: this watch's own
 * reads, and every push the panel makes while it lasts. A session's pane does not move under it,
 * so finding it again per read or per keystroke would be paying fifty milliseconds to be told the
 * same thing.
 *
 * A session with no pane ENDS rather than waiting: there is nothing to hang a pipe on, and a
 * session gains a pane later often enough to matter -- pressing the band's own terminal button
 * resumes one. Ending hands the retry to whoever asked, where a stream that stayed open would
 * have to grow a timer to notice, which is the thing this replaced.
 *
 * A pane that DIES is not noticed here, and deliberately: the pipe simply goes quiet. It is
 * noticed at the next push, whose tmux call fails and drops the held pane -- the same place
 * `useCliInput` corrects a session that died under the composer, and the moment a reader is
 * about to care.
 */
export function observeTmuxComposer(
  sessionId: string,
  listener: TmuxComposerListener,
  runtime: TmuxComposerWatchRuntime,
): () => void {
  const { onState } = listener;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  /** What the last report said, so an unchanged screen is not reported again. */
  let reported: string | null = null;
  let unwatch: (() => void) | null = null;
  let release: (() => void) | null = null;
  /** Resolved once, at the top, and used by every read this watch makes. */
  let pane: string | null = null;

  const end = (): void => {
    if (stopped) return;
    stopped = true;
    listener.onEnd();
  };

  const report = (state: TmuxComposerEnvelope): void => {
    if (stopped) return;
    const signature = JSON.stringify(state);
    if (signature === reported) return;
    reported = signature;
    onState(state);
  };

  const readNow = async (): Promise<void> => {
    if (stopped || reading || pane === null) return;
    reading = true;
    try {
      const composer = await readComposerAt(pane, runtime);
      // The dialog takes the composer box away entirely for as long as it is up, so `no-composer`
      // is exactly when to look for one -- and the only time this pays for a second capture.
      const question = composer.reason === "no-composer"
        ? await readQuestionAt(pane, runtime)
        : null;
      report({ composer, question });
    } catch {
      // A read that threw is not evidence about the composer, and the next output brings another.
    } finally {
      reading = false;
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void readNow();
    }, COALESCE_MS);
  };

  void (async () => {
    let found: string | null;
    try {
      found = await runtime.pane(sessionId);
    } catch {
      found = null;
    }
    if (stopped) return;
    if (!found) {
      report({ composer: unavailable("no-pane"), question: null });
      end();
      return;
    }
    try {
      const stop = await runtime.watch(found, schedule);
      if (stopped) {
        stop();
        return;
      }
      unwatch = stop;
    } catch {
      report({ composer: unavailable("tmux-unavailable"), question: null });
      end();
      return;
    }
    pane = found;
    // Published only now, with the pipe actually set: a push against a pane this watch failed to
    // join should go and resolve for itself rather than take this one's word for it.
    release = runtime.panes.hold(sessionId, found);
    // The first reading is not waited for: a pane that is sitting idle writes nothing, so a
    // watcher that only spoke on output would say nothing at all until somebody typed.
    await readNow();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unwatch?.();
    release?.();
  };
}

/**
 * The question dialog standing in `pane`, or null when there is none.
 *
 * Null for an unreadable screen too, and that is safe here in a way it is not in the driver: this
 * only decides what a panel DRAWS, where the driver decides whether keys go out. A reading that
 * missed a dialog shows a mirror without the pane's own state for one poll; the next output brings
 * another.
 */
export async function readQuestionAt(
  pane: string,
  runtime: Pick<TmuxComposerRuntime, "questionScreen">,
): Promise<TmuxQuestionState | null> {
  try {
    const dialog = questionDialog(await runtime.questionScreen(pane));
    return dialog === null ? null : questionStateFrom(dialog);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return null;
    throw error;
  }
}

/** What the composer in `pane` is showing, or why it cannot be seen. */
export async function readComposerAt(
  pane: string,
  runtime: Pick<TmuxComposerRuntime, "screen">,
): Promise<TmuxComposerState> {
  let box: ComposerBox | null;
  try {
    box = composerBox(await runtime.screen(pane));
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  if (!box) return unavailable("no-composer");
  return {
    text: composerText(box.rows),
    hint: box.hint,
    reason: null,
    exact: box.exact && box.rows.length === 1,
    commands: box.commands,
  };
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

export function unavailable(reason: NonNullable<TmuxComposerState["reason"]>): TmuxComposerState {
  return { text: null, hint: null, reason, exact: true, commands: [] };
}
