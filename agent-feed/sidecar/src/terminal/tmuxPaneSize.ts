// Making a tmux window the shape a viewer asked for, on a window every client shares.
//
// Separate from the attachment registry because the rules here are all about one
// resource that cannot be held twice -- tmux has one size per window and one applier
// per pane -- while the registry is about who is watching. Every comment below is a
// measurement; read them before changing the ordering.

import type { TmuxPaneRuntime, TmuxSessionConnection } from "@/terminal/tmuxAttachment";

/**
 * One pane's pipe and the viewers watching it.
 *
 * `viewers` is what decides the pipe's lifetime rather than a count, because a viewer that fails to
 * unsubscribe would otherwise leak the pane's pipe forever and there would be nothing to see it.
 */
export interface SharedPane {
  readonly session: string;
  readonly viewers: Set<TmuxSessionConnection>;
  readonly stop: () => Promise<void>;
  pid: number;
  columns: number;
  rows: number;
  revision: number;
  /** The shape the most recent viewport report asked for, waiting for the applier to reach it. */
  wanted: { columns: number; rows: number } | null;
  /** The applier, while one is running. Present means a later ask joins it instead of racing it. */
  resizing: Promise<void> | null;
}

/**
 * Makes the pane the shape a viewer asked for, when tmux says nobody else is watching.
 *
 * The guard is the whole design. tmux has ONE window size per session, so setting it is setting it
 * for every client -- and the last time this repo resized panes, a tile opening at 80x24 reflowed a
 * live Claude Code TUI inside the human's own terminal and left its composer drawing off the bottom
 * of its frame. What made that harmful was a client being attached, and tmux answers that question
 * directly, so the resize is conditional rather than forbidden. Being a real tmux client instead
 * would not help: measured, a control-mode client's `refresh-client -C` reshapes the window for
 * everyone the same way, and the window keeps the new shape after that client detaches.
 *
 * LATEST WINS, deliberately, and it is also what tmux's own `window-size latest` means. Two cards
 * on one session are two boxes of different shapes with one answer between them; the alternative,
 * largest, hands the smaller card a grid it has to shrink its type to read, which is the problem
 * this exists to remove.
 *
 * KNOWN DEFECT, and the reason to care about the paragraph above: two viewers of DIFFERENT widths
 * on one pane make it OSCILLATE, and this does not damp. Each open viewer republishes its own box
 * on every checkpoint and every move sends a checkpoint, so the two trade the window forever.
 * Measured at 48x16 against 132x40: 145 transitions in 400 samples over half a minute, roughly
 * five a second, with the pane spending 194 samples at 132 and 164 at 48. A TUI on that pane
 * reflows every time.
 *
 * One viewer per pane is every arrangement this repo actually makes today, which is why it ships,
 * but a second card on one session is one click away and there is no guard. The fix, when it is
 * wanted, is to let the most recent SUBSCRIBER own the shape until it leaves, rather than the most
 * recent report -- that keeps latest-wins for the case it was chosen for and stops the fight.
 *
 * Measure this at 50ms or finer. At 500ms a five-a-second oscillation aliases into what looks like
 * a settled pane: the first run of this test read four transitions and thirty still seconds, and
 * that reading is what the comment here used to claim. The tell was the checkpoint count -- 447 per
 * viewer against four apparent moves -- and the number that is not aliased is the checkpoint count,
 * because one move sends exactly one. And do NOT try this from two browser tabs: a backgrounded tab
 * stops rendering and stops publishing, so it holds no shape and there is only ever one viewer.
 * Two API clients against a private sidecar is what worked.
 *
 * Bursts collapse rather than queue: the loop re-reads `wanted` each time round, so a drag that
 * reports twenty sizes costs the tmux calls for the last one plus whichever was in flight.
 */
/**
 * Re-reads the pane's shape for a viewer that does not claim it, and redraws if it moved.
 *
 * A follower renders at the PANE's grid rather than its own, so it needs the current one -- and
 * geometry was only ever re-read as a side effect of this side's own resize, which a follower by
 * definition never performs. Without this, a pane that changes shape underneath one (somebody
 * attaches a terminal, or resizes the window it is open in) leaves every follower rendering an
 * absolutely-addressed screen into the grid the pane had when they opened, which is how text lands
 * a row off from where the screen says it is.
 *
 * The redraw is the one a reshape needs and for the same reason: tmux draws a reflow per client,
 * so with no clients not one byte of the new screen reaches the pipe. Sent only on an actual move,
 * because a checkpoint clears and repaints every viewer -- see `adoptPaneSize` for the storm that
 * fanning these out per caller produced.
 */
export async function refreshPaneSize(runtime: TmuxPaneRuntime, pane: SharedPane): Promise<void> {
  const geometry = await runtime.describe(pane.session);
  if (geometry.columns === pane.columns && geometry.rows === pane.rows) return;
  pane.columns = geometry.columns;
  pane.rows = geometry.rows;
  for (const viewer of pane.viewers) viewer.requestCheckpoint("");
}

export async function adoptPaneSize(
  runtime: TmuxPaneRuntime,
  pane: SharedPane,
  columns: number,
  rows: number,
): Promise<void> {
  pane.wanted = { columns, rows };
  // Joining the running applier rather than starting a second: two resizes racing on one window
  // land in an order neither caller chose, and the loser's shape is what sticks.
  if (pane.resizing) return pane.resizing;
  const applier = (async () => {
    for (let want = pane.wanted; want !== null; want = pane.wanted) {
      pane.wanted = null;
      if (want.columns === pane.columns && want.rows === pane.rows) continue;
      // Asked every pass, not once: a human can attach between two reports, and the whole
      // guarantee is that this never reshapes a session somebody is sitting in front of.
      if (await runtime.clients(pane.session) > 0) return;
      await runtime.resize(pane.session, want.columns, want.rows);
      // Handed straight back. `resize-window -x -y` pins the window to `window-size manual` as a
      // side effect -- measured, and it is what left four sessions stuck that way the last time
      // this repo resized panes. Unsetting keeps the size and restores tmux's own negotiation, so
      // a human who attaches a moment later gets their own terminal's shape at once instead of
      // the 44x23 some card left behind. Measured end to end: resize to 44x23, unset, attach a
      // client at 150x45, window is 150x45.
      //
      // Immediately rather than when the last viewer leaves, which is where this lived first: a
      // pin held for the life of a card is a pin held across exactly the window in which somebody
      // might attach, which is the case it exists to protect.
      await runtime.releaseSize(pane.session);
      // Read back rather than assumed. tmux clamps a window to what its layout can hold, so the
      // shape that lands is not always the shape that was asked for, and the viewer is about to
      // render against whichever it really is.
      const geometry = await runtime.describe(pane.session);
      const moved = geometry.columns !== pane.columns || geometry.rows !== pane.rows;
      pane.columns = geometry.columns;
      pane.rows = geometry.rows;
      if (!moved) continue;
      // Fanned out HERE, once per actual move, rather than from the caller's continuation.
      //
      // Every caller that arrived while an applier was running is handed that applier's promise,
      // so a `.then` on it runs once PER CALLER. One real resize with forty reports queued behind
      // it therefore sent forty checkpoints to every viewer, each of which clears and repaints a
      // whole terminal, and each of which makes a viewer republish -- which queues more callers.
      // Measured before this moved: two viewers on one pane made it change shape four times and
      // then hold, while sending 894 viewport reports and taking 447 checkpoints EACH over the
      // following half minute. The pane was right and the redraws were a storm.
      for (const viewer of pane.viewers) viewer.requestCheckpoint("");
    }
  })();
  pane.resizing = applier;
  // Cleared from OUTSIDE the applier, and this is not a style choice. An applier whose every
  // iteration hits the `continue` above finishes SYNCHRONOUSLY, so a `finally` written inside it
  // runs before `pane.resizing` is even assigned -- and the assignment then latches a settled
  // promise that nothing ever clears. Every later report joins it and returns without resizing.
  // Measured on three live cards: each reached a size, took one report that matched it, and then
  // ignored every ask after that, sitting six or seven columns short of the box for good.
  void applier.finally(() => {
    if (pane.resizing === applier) pane.resizing = null;
    // Swallowed HERE only. The applier's rejection is the caller's to report -- this branch of it
    // exists to clear the latch, and leaving it unhandled makes a failed tmux call an unhandled
    // rejection as well as a logged one.
  }).catch(() => {});
  return applier;
}
