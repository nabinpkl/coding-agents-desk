// The pane a session's composer is on, held for as long as somebody is watching it, and
// the one-turn-at-a-time rule two pushes at one session have to obey.
//
// Both are about exclusivity: resolving a pane is the expensive act in this module, and
// two pushes reading the same box would each paste their whole text into it.

import { waitFor } from "@/input/composer/composerKeystrokes";
import type { TmuxComposerRuntime } from "@/input/tmuxComposerRuntime";

/**
 * The pane each live watch is sitting on, published so a push does not have to go and find one.
 *
 * Resolving a pane is the expensive act in this module: it reads every session record on disk and
 * asks the kernel about each pid, which is a `ps` per record and about fifty milliseconds. Doing
 * it per keystroke burst is pure waste, because a watch resolved that same pane when it opened and
 * has been holding it ever since -- the panel cannot push at all without one, since the band that
 * owns the field only appears once a watch has reported.
 *
 * Held rather than cached: an entry exists for exactly as long as a watch is on it, so it cannot
 * go stale sitting in a map nobody is looking at. A caller that finds nothing held goes and
 * resolves, which is what keeps a push working across the gap while a dropped stream reconnects.
 */
export interface TmuxComposerPanes {
  /** Records the pane a watch is on, until the returned function is called. */
  hold: (sessionId: string, pane: string) => () => void;
  /** The pane a watch is holding for this session, or null when none is. */
  get: (sessionId: string) => string | null;
  /** Drops a pane that stopped answering, so the next caller goes and looks again. */
  forget: (sessionId: string) => void;
}

export function composerPanes(): TmuxComposerPanes {
  /** A token per watch rather than a count, so two panels on one session hold it independently. */
  const held = new Map<string, Set<{ pane: string }>>();
  return {
    hold(sessionId, pane) {
      const token = { pane };
      const holders = held.get(sessionId) ?? new Set<{ pane: string }>();
      holders.add(token);
      held.set(sessionId, holders);
      return () => {
        holders.delete(token);
        // Only if this set is still the one on the map. A `forget` between the hold and the
        // release detaches it, and a later watch puts its own there; deleting by key alone would
        // then drop that watch's pane on this one's way out.
        if (holders.size === 0 && held.get(sessionId) === holders) held.delete(sessionId);
      };
    },
    get(sessionId) {
      for (const token of held.get(sessionId) ?? []) return token.pane;
      return null;
    },
    forget(sessionId) {
      held.delete(sessionId);
    },
  };
}

/**
 * The turn in progress on each session's box, so a second one waits rather than interleaving.
 *
 * Every function here that touches a composer READS the screen and then WRITES to it, and those
 * two halves are not atomic. Two of them overlapping is not a rare race: the panel debounces at
 * 90ms and a push over a slow link takes longer than that, so a reader typing normally has a
 * second push starting before the first has landed. Both read the same box, both compute their
 * keystrokes from it, and both paste their whole text.
 *
 * Measured 2026-09-07, two pushes fired together at an empty box, "hello wor" and "hello world
 * now": the box ended up holding `hello world nowhello wor`, and each request answered 200 with
 * its own text, so nothing anywhere reported a problem. That is the shape the reader sees -- every
 * draft they typed, concatenated in the order the sends happened to land.
 *
 * Process-wide rather than per-runtime, because the thing being serialised is the pane, and the
 * two live surfaces (a phone and a Mac, both real, both able to drive one session) reach it
 * through different requests.
 *
 * On `globalThis` rather than in this module, and that is not ceremony. The sidecar runs under
 * `bun --watch`, which re-reads a changed module IN PROCESS and rebinds the port without the
 * supervisor ever seeing an exit -- so module-level state is discarded while the requests already
 * running are not. A plain `const` here would hand the reloaded module an empty map, and the turns
 * still in flight from the previous one would be serialised against nothing: two of them on one
 * box again, which is the whole defect coming back at exactly the moment somebody is editing this
 * file. Measured 2026-09-07: both sidecars re-executed at 20:11:27 while a reader was typing, and
 * that reader got their draft back concatenated.
 */
const TURN_STORE = Symbol.for("agentdesk.composerTurns");
const TURNS: Map<string, Promise<void>> =
  ((globalThis as Record<symbol, unknown>)[TURN_STORE] ??= new Map<string, Promise<void>>()) as
    Map<string, Promise<void>>;

/**
 * Runs `work` after whatever is already in flight for this session, and reports its own result.
 *
 * The chain the next caller waits on is one that never rejects, so a failed turn holds nothing up
 * and cannot re-throw into an unrelated caller. The map entry is dropped when the chain drains,
 * which keeps this from being a per-session leak in a sidecar that sees thousands of them.
 */
export function inTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const result = (TURNS.get(sessionId) ?? Promise.resolve()).then(work);
  const drained = result.then(() => {}, () => {});
  TURNS.set(sessionId, drained);
  void drained.then(() => {
    if (TURNS.get(sessionId) === drained) TURNS.delete(sessionId);
  });
  return result;
}

/**
 * Waits for the pane to redraw from a send, so the next turn reads the box and not its past.
 *
 * Serialising the turns is only half of it. The second turn still starts by reading the screen,
 * and the screen does not carry what was just sent for another few tens of milliseconds -- so
 * without this it reads the box as it was BEFORE the previous turn, computes a diff against text
 * that is already gone, and corrupts the pane exactly as two concurrent turns would.
 *
 * What it waits for is the reading being DIFFERENT, not the reading being right. A composer whose
 * text wraps cannot be reconstructed exactly (see the header), so waiting for it to equal what was
 * asked for would spin out the full limit on every wrapped push. Difference is observable in every
 * case and is the actual question: has this send reached the screen yet.
 *
 * A box that reads as nothing at all is a pane mid-redraw, which is not an answer either way, so
 * it keeps waiting. Passing `null` says there is nothing to wait for and returns at once.
 *
 * It swallows its own failures, which is the one place in this module that is right. The send has
 * already happened by the time this runs, so a tmux that stops answering DURING the wait says
 * nothing about whether the push landed -- and letting that throw would report a push that reached
 * the box as a session with no tmux, clearing the held pane on the way out. Waiting simply stops;
 * the next turn reads the pane and reports what it finds.
 */
export async function settle(
  pane: string,
  before: string | null,
  runtime: TmuxComposerRuntime,
): Promise<void> {
  if (before === null) return;
  await waitFor(pane, runtime, (text) => text !== before);
}
