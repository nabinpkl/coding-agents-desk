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
 *
 * A shown pane also remembers the height its reader dragged it to. That is the same kind of fact
 * as the toggle and belongs beside it rather than in a store of its own: both answer "how did this
 * reader arrange this session's pane", and splitting them would mean two records that can disagree
 * about whether the pane exists.
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

interface Remembered {
  /** Insertion-ordered: the tail is the most recent choice, so the head is what a cap evicts. */
  shown: Set<string>;
  /**
   * The height each shown pane was last dragged to, for the sessions whose reader dragged one.
   *
   * Only ever holds keys that `shown` holds. A height belongs to a pane that is up: kept for a
   * hidden one it would be a record of nothing, and it would cost the cap its meaning, since the
   * cap counts arrangements rather than sessions ever seen. The consequence, stated because it is
   * a real one: hiding a pane forgets its size, and showing it again opens at the size its screen
   * wants. A reload is what this survives.
   */
  heights: Map<string, number>;
}

let remembered = load();

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
function load(): Remembered {
  const empty: Remembered = { shown: new Set(), heights: new Map() };
  if (typeof window === "undefined") return empty;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return empty;
    const read: Remembered = { shown: new Set(), heights: new Map() };
    for (const entry of stored) {
      if (typeof entry === "string") {
        read.shown.add(entry);
        continue;
      }
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      read.shown.add(entry[0]);
      // The second slot carried a mode before it carried a height, so it is read as a height only
      // when it IS one. Everything else is a pane that is up and has never been dragged.
      if (typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0) {
        read.heights.set(entry[0], entry[1]);
      }
    }
    return read;
  } catch {
    return empty;
  }
}

function store(state: Remembered): void {
  try {
    const entries = [...state.shown].map((key) => {
      const height = state.heights.get(key);
      return height === undefined ? key : [key, height];
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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
  if (next.shown.has(key)) {
    next.shown.delete(key);
    next.heights.delete(key);
  } else {
    next.shown.add(key);
    // Deleting from the front of an insertion-ordered Set is how it stays bounded, and it drops
    // the choice made longest ago rather than the one just made.
    while (next.shown.size > REMEMBERED_SESSIONS) {
      const oldest = next.shown.values().next().value as string;
      next.shown.delete(oldest);
      next.heights.delete(oldest);
    }
  }
  remembered = next;
  store(next);
  for (const listener of listeners) listener();
}

/** The height this session's pane was last dragged to, or null for one nobody has dragged. */
export function terminalComposerHeight(session: TerminalComposerSession): number | null {
  return remembered.heights.get(sessionKey(session)) ?? null;
}

/**
 * Remembers the height a reader just dragged this session's pane to.
 *
 * Re-reads before writing, for the reason `toggleTerminalComposer` does: two tabs on this origin
 * are ordinary, and a write that put its own view of the store back would erase what the other
 * one arranged.
 *
 * Notifies nobody. A drag calls this on every pointer move, and the one reader of this store
 * subscribes to whether a pane is SHOWN, which a resize cannot change -- so waking every band on
 * the page sixty times a second would be work in exchange for no repaint. The height is read when
 * a pane mounts, which is the only moment it is wanted.
 */
export function setTerminalComposerHeight(
  session: TerminalComposerSession,
  height: number,
): void {
  if (!Number.isFinite(height) || height <= 0) return;
  const key = sessionKey(session);
  const next = load();
  // Presence in `shown` is what showing means here, so a height for a pane that is not up would
  // be a row nothing can ever read back.
  if (!next.shown.has(key)) return;
  next.heights.set(key, Math.round(height));
  remembered = next;
  store(next);
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
    () => remembered.shown.has(key),
    () => false,
  );
}
