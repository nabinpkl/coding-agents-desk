// What the composer needs from tmux, and the one queue that keeps two drivers off one box.
//
// The seam is injected rather than called directly so the suite needs no tmux server, and the
// registry of open panes lives here because a watch opened through the routes has to be visible to
// a push that took the default runtime -- two registries would be two answers to one question.
//
// `inTurn` is the other thing this file owns and the more load-bearing of the two. Everything that
// writes into a pane goes through it, including the rewind driver next door, because two senders
// interleaving in one box is exactly the corruption the hypothesis rule in `composerKeys.ts` is
// written to make impossible.

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import { liveTmuxSession } from "../../terminal/agentTerminalService.ts";
import {
  captureTmuxPaneView,
  hexSend,
  TmuxUnavailable,
  type TmuxPaneView,
} from "../../terminal/tmuxSessions.ts";
import { composerBox, composerText, type ComposerBox } from "./composerScreen.ts";
import { BACKSPACE, KILL_ROW, PASTE_START } from "./composerKeys.ts";

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
 * Only a DESTRUCTIVE prefix is split off and waited for. `END` alone changes nothing the paste
 * depends on, and gating it would put a screen read in front of every keystroke a reader types --
 * which is the append path, and the common one.
 */
export async function sendEdit(
  pane: string,
  keys: string,
  runtime: Pick<TmuxComposerRuntime, "screen" | "send">,
): Promise<void> {
  const encoder = new TextEncoder();
  const at = keys.indexOf(PASTE_START);
  const edit = at === -1 ? keys : keys.slice(0, at);
  if (at === -1 || !(edit.includes(KILL_ROW) || edit.includes(BACKSPACE))) {
    await runtime.send(pane, encoder.encode(keys));
    return;
  }
  await runtime.send(pane, encoder.encode(edit));
  // A clear is done when the box reads empty; a backspace run, when it reads anything other than
  // what it read before. Waiting on the SCREEN rather than on a sleep is the same discipline
  // `settle` already uses, and it is what keeps this correct on a pane that is busy rather than
  // correct on the one it was measured against.
  const cleared = edit.includes(KILL_ROW);
  await waitFor(pane, runtime, (text) => (cleared ? text.length === 0 : true));
  await runtime.send(pane, encoder.encode(keys.slice(at)));
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
 *
 * Exported because this module is no longer the only thing that drives a pane: `rewindPicker.ts`
 * takes a turn the same way, and two drivers sending into one box at once is precisely what the
 * queue exists to prevent. The registry is process-wide (`Symbol.for`), so both see one queue.
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
export function failed(
  sessionId: string,
  error: unknown,
  runtime: TmuxComposerRuntime,
): TmuxComposerState {
  if (!(error instanceof TmuxUnavailable)) throw error;
  runtime.panes.forget(sessionId);
  return unavailable("tmux-unavailable");
}

export function unavailable(reason: NonNullable<TmuxComposerState["reason"]>): TmuxComposerState {
  return { text: null, hint: null, reason, exact: true, commands: [] };
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
