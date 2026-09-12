/**
 * Which sessions show their tmux pane above the composer, remembered across visits.
 *
 * Per session, not per reader. It began as one global boolean on the theory that this is a
 * preference about how you like to type, and that is wrong about what the control does: it is
 * about one session -- whether you want to watch THIS agent's screen while you write to it -- and
 * those are different answers for different sessions at the same moment. A single flag made
 * opening a pane on one session silently open it on every other.
 *
 * Held outside React so the choice survives the band being rebuilt, which it is whenever the Feed
 * re-reads a session's status.
 *
 * ON means the pane is viewable above the field. OFF means it is hidden. The field is there either
 * way: it is the surface every session has, and the control is about what stands ABOVE it rather
 * than about which of two surfaces gets the band. That is the whole of the state -- it was briefly
 * three, with a second "on" that took the field away, and one control answering two questions is
 * one too many for a button whose whole job is "is the screen up".
 *
 * OFF by default, so only the sessions turned on are stored: a session never touched has nothing
 * to remember. Capped so a store of every session ever opened cannot accumulate; the oldest choice
 * is the one dropped.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

/** How many sessions keep a remembered pane. Oldest out first, so recent arrangement survives. */
const REMEMBERED_SESSIONS = 64;

export interface TerminalComposerSession {
  source: string;
  sessionId: string;
}

const listeners = new Set<() => void>();
/** Insertion-ordered: the tail is the most recent choice, so the head is what a cap evicts. */
let shown = load();

function sessionKey(session: TerminalComposerSession): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * Reads the store, taking every shape it has had with it.
 *
 * Two have been written. A bare key, which meant the terminal was up; and a `[key, mode]` pair from
 * the brief three-state spell, whose two modes were both ways of having the pane up. Every one of
 * them resolves to ON, because that is what each of them meant -- a reader who arranged something
 * finds it still arranged rather than silently back at the default.
 *
 * Anything else remembers nothing. A hand-edited or half-written store must fall back to the
 * default, not become a lookup that answers for a session it cannot name.
 */
function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return new Set();
    const read = new Set<string>();
    for (const entry of stored) {
      if (typeof entry === "string") read.add(entry);
      else if (Array.isArray(entry) && typeof entry[0] === "string") read.add(entry[0]);
    }
    return read;
  } catch {
    return new Set();
  }
}

function store(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...shown]));
  } catch {
    /* storage disabled */
  }
}

/**
 * Shows this session's pane, or hides it.
 *
 * Re-reads the store first, and the in-memory set is a cache for rendering rather than the record.
 * Two tabs on this origin are ordinary here -- the panel is read while it is being edited -- and a
 * press that wrote its own set back wholesale would erase every session the OTHER tab had
 * arranged, silently, on a press about something else.
 */
export function toggleTerminalComposer(session: TerminalComposerSession): void {
  const key = sessionKey(session);
  const next = load();
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    // Deleting from the front of an insertion-ordered Set is how it stays bounded, and it drops
    // the choice made longest ago rather than the one just made.
    while (next.size > REMEMBERED_SESSIONS) next.delete(next.values().next().value as string);
  }
  shown = next;
  store();
  for (const listener of listeners) listener();
}

export function useTerminalComposerShown(session: TerminalComposerSession): boolean {
  // Read through the key so the snapshot is a boolean: `useSyncExternalStore` compares snapshots by
  // identity, and handing it the Set would re-render every session's band on any session's press.
  const key = sessionKey(session);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown.has(key),
    () => false,
  );
}
