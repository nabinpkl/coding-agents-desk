/**
 * How each session's band is arranged: the field, the terminal, or both.
 *
 * Per session, not per reader. It began as one global boolean on the theory that this is a
 * preference about how you like to type, and that is wrong about what the toggle does: the choice
 * is about one session -- whether you are driving this agent by hand or writing to it -- and those
 * are different answers for different sessions at the same moment. A single flag made opening a
 * terminal on one session silently open it on every other, replacing the field the reader was
 * about to type into.
 *
 * Held outside React so the choice survives the band being rebuilt, which it is whenever the Feed
 * re-reads a session's status.
 *
 * THREE states rather than two, since 2026-09-09. `field` and `terminal` were the whole set while
 * showing both meant stacking two full-height input surfaces, which spent two thirds of the band on
 * input. `echo` is the arrangement that was missing: the field, plus a short peek at the pane
 * showing the line the field is being mirrored INTO. A reader typing into a tmux-backed session
 * watches their own text arrive in the agent's composer, which is the one thing neither of the
 * other two states can show.
 *
 * `field` is still the default, and still for the reason it became one: the terminal is the surface
 * some sessions have and the field is the surface every session has, so a default that hides the
 * field hides more than it offers. Only a reader who asked for something else gets it.
 *
 * So only the sessions arranged AWAY from the default are stored: a session never touched has
 * nothing to remember. Capped so a store of every session ever opened cannot accumulate; the oldest
 * choice is the one dropped.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

/** How many sessions keep a remembered arrangement. Oldest out first, so recent arrangement survives. */
const REMEMBERED_SESSIONS = 64;

/**
 * What the band shows for one session.
 *
 * `echo` is the two-surface state and `terminal` is the terminal ALONE, which is the order a press
 * walks them in: the cheapest press reaches the arrangement that hides nothing, and giving the
 * field up is the deliberate second one.
 */
export type TerminalComposerMode = "field" | "echo" | "terminal";

/** The order a press walks. `field` is the default and the one a third press returns to. */
const CYCLE: readonly TerminalComposerMode[] = ["field", "echo", "terminal"];

export interface TerminalComposerSession {
  source: string;
  sessionId: string;
}

const listeners = new Set<() => void>();
/** Insertion-ordered: the tail is the most recent choice, so the head is what a cap evicts. */
let arranged = load();

function sessionKey(session: TerminalComposerSession): string {
  return `${session.source}:${session.sessionId}`;
}

function isMode(value: unknown): value is Exclude<TerminalComposerMode, "field"> {
  return value === "echo" || value === "terminal";
}

/**
 * Reads the store, taking the two-state shape with it.
 *
 * The old value was an array of session keys, and a key being present meant the terminal was up.
 * That state still exists and still has a name, so those entries resolve to `terminal` rather than
 * being discarded -- the reader arranged something and it is still arrangeable. The shapes tell
 * themselves apart by their elements, a bare string against a pair, so neither needs a version.
 *
 * Anything else remembers nothing. A hand-edited or half-written store must fall back to the
 * default, not become a lookup that answers a session with a state that does not exist.
 */
function load(): Map<string, Exclude<TerminalComposerMode, "field">> {
  const empty = new Map<string, Exclude<TerminalComposerMode, "field">>();
  if (typeof window === "undefined") return empty;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return empty;
    const read = new Map<string, Exclude<TerminalComposerMode, "field">>();
    for (const entry of stored) {
      if (typeof entry === "string") read.set(entry, "terminal");
      else if (Array.isArray(entry) && typeof entry[0] === "string" && isMode(entry[1])) {
        read.set(entry[0], entry[1]);
      }
    }
    return read;
  } catch {
    return empty;
  }
}

function store(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...arranged]));
  } catch {
    /* storage disabled */
  }
}

/**
 * Walks this session to the next arrangement.
 *
 * Re-reads the store first, and the in-memory map is a cache for rendering rather than the record.
 * Two tabs on this origin are ordinary here -- the panel is read while it is being edited -- and a
 * press that wrote its own map back wholesale would erase every session the OTHER tab had
 * arranged, silently, on a press about something else.
 */
export function cycleTerminalComposer(session: TerminalComposerSession): void {
  const key = sessionKey(session);
  const next = load();
  const current = next.get(key) ?? "field";
  const wanted = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!;
  // Deleted rather than stored as "field": the default is the absence, so a session walked back to
  // it stops taking a slot from the sessions that are still arranged.
  next.delete(key);
  if (wanted !== "field") {
    next.set(key, wanted);
    // Deleting from the front of an insertion-ordered Map is how it stays bounded, and it drops
    // the choice made longest ago rather than the one just made.
    while (next.size > REMEMBERED_SESSIONS) next.delete(next.keys().next().value as string);
  }
  arranged = next;
  store();
  for (const listener of listeners) listener();
}

export function useTerminalComposerMode(session: TerminalComposerSession): TerminalComposerMode {
  // Read through the key so the snapshot is one session's own mode: `useSyncExternalStore` compares
  // snapshots by identity, and handing it the Map would re-render every session's band on any
  // session's press.
  const key = sessionKey(session);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => arranged.get(key) ?? "field",
    () => "field",
  );
}
