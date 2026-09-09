/**
 * Which sessions type into their own terminal rather than into the composer field, remembered
 * across visits.
 *
 * Per session, not per reader. It began as one global boolean on the theory that this is a
 * preference about how you like to type, and that is wrong about what the toggle now does: the
 * terminal appears INSTEAD of the field, so the choice is about one session -- whether you are
 * driving this agent by hand or writing to it -- and those are different answers for different
 * sessions at the same moment. A single flag made opening a terminal on one session silently open
 * it on every other, replacing the field the reader was about to type into.
 *
 * Held outside React so the choice survives the band being rebuilt, which it is whenever the Feed
 * re-reads a session's status.
 *
 * OFF by default. It used to be on, which was right while the terminal appeared above the field and
 * cost only space; now it appears instead of the field, and a default that hides the composer hides
 * the thing every session has. The argument for the old default -- a terminal nobody finds -- is
 * answered by the toggle sitting beside the field rather than by showing the terminal to everyone.
 *
 * So only the sessions turned ON are stored: the set is what the reader arranged, and a session
 * never touched has nothing to remember. Capped so a store of every session ever opened cannot
 * accumulate; the oldest choice is the one dropped.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

/** How many sessions keep a remembered terminal. Oldest out first, so recent arrangement survives. */
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

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return new Set();
    // Validated rather than cast: a hand-edited or stale shape must fall back to remembering
    // nothing, not become a lookup that answers for a session it cannot name.
    return new Set(stored.filter((each): each is string => typeof each === "string"));
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
 * Turns this session's terminal on or off.
 *
 * Re-reads the store first, and the in-memory set is a cache for rendering rather than the record.
 * Two tabs on this origin are ordinary here -- the panel is read while it is being edited -- and a
 * toggle that wrote its own set back wholesale would erase every session the OTHER tab had
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
  // identity, and handing it the Set would re-render every session's band on any session's toggle.
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
