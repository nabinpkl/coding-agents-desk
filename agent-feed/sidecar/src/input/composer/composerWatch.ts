// Reporting what a session's composer holds, for as long as somebody is looking.
//
// Driven by the pane's own output rather than by a clock, which is why an idle session costs
// nothing at all: see `COALESCE_MS` in `composerRuntime.ts` for what paces it and why the read is
// trailing rather than leading.

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import {
  COALESCE_MS,
  liveTmuxComposerRuntime,
  readComposerAt,
  unavailable,
  type TmuxComposerWatchRuntime,
} from "./composerRuntime.ts";


/** Where a watcher's reports go, and how it says there will be no more of them. */
export interface TmuxComposerListener {
  onState: (state: TmuxComposerState) => void;
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

  const report = (state: TmuxComposerState): void => {
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
      report(await readComposerAt(pane, runtime));
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
      report(unavailable("no-pane"));
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
      report(unavailable("tmux-unavailable"));
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

