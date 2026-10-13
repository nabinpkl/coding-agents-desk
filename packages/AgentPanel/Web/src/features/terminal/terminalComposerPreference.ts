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
 * than about which of two surfaces gets the band. That is the whole of the toggle -- it was briefly
 * three states, with a second "on" that took the field away, and one control answering two
 * questions is one too many for a button whose whole job is "is the screen up".
 *
 * A pane also remembers the height its reader dragged it to, and keeps it while hidden. That is the
 * same kind of fact as the toggle and belongs beside it rather than in a store of its own: both
 * answer "how did this reader arrange this session's pane". It used to be dropped on hide, on the
 * theory that closing a pane closes the arrangement -- and in use a reader hides the screen to get
 * the transcript back for a moment and shows it again expecting the size they chose, so a toggle
 * that reset it undid a drag every time it was pressed.
 *
 * OFF by default with no height, so a session never touched has nothing to remember. A surface
 * whose sessions live in panes the reader is there to type in (an arena lane) asks for ON by
 * default instead, and for those a hide is what gets remembered, so closing the pane keeps it
 * closed. Capped so a store of every session ever opened cannot accumulate; the pane toggled
 * longest ago is the one dropped.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

/** How many sessions keep a remembered pane. Oldest out first, so recent arrangement survives. */
const REMEMBERED_SESSIONS = 64;

/** Marks a stored entry whose pane is hidden. Absent means shown, which every older entry is. */
const HIDDEN = "hidden";

export interface TerminalComposerSession {
  source: string;
  sessionId: string;
  /** What this session's pane is when nobody has toggled it: hidden unless the surface says. */
  shownByDefault?: boolean;
}

const listeners = new Set<() => void>();

interface Arrangement {
  shown: boolean;
  /** The height the pane was last dragged to, or null for one nobody has dragged. */
  height: number | null;
}

/**
 * Insertion-ordered: the tail is the pane toggled most recently, so the head is what a cap
 * evicts. Never holds a hidden pane with no height -- that is the default, and a record of the
 * default would spend the cap on nothing.
 */
type Remembered = Map<string, Arrangement>;

let remembered = load();

function sessionKey(session: TerminalComposerSession): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * Reads the store, taking every shape it has had with it.
 *
 * A bare key is a shown pane nobody dragged. A `[key, height]` pair is a shown pane with a height,
 * and `[key, height, "hidden"]` a hidden one that keeps it. The same pair's second slot carried a
 * mode during the brief three-state spell, and both of those modes were ways of having the pane up,
 * so a slot that is not a height reads as a shown pane nobody dragged.
 *
 * Anything else remembers nothing. A hand-edited or half-written store must fall back to the
 * default, not become a lookup that answers for a session it cannot name.
 */
function load(): Remembered {
  const read: Remembered = new Map();
  if (typeof window === "undefined") return read;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return read;
    for (const entry of stored) {
      if (typeof entry === "string") {
        read.set(entry, { shown: true, height: null });
        continue;
      }
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const height = typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
        ? entry[1]
        : null;
      // A hidden pane with no height is stored only for a session shown by default, where the hide
      // is the choice; for any other it would be the default, and is never written.
      read.set(entry[0], { shown: entry[2] !== HIDDEN, height });
    }
    return read;
  } catch {
    return new Map();
  }
}

function store(state: Remembered): void {
  try {
    const entries = [...state].map(([key, { shown, height }]) => {
      if (!shown) return [key, height, HIDDEN];
      return height === null ? key : [key, height];
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage disabled */
  }
}

/**
 * Puts a session's arrangement at the tail, as the most recent, and evicts past the cap. An
 * arrangement that is the session's default with nothing dragged is dropped instead.
 */
function arrange(state: Remembered, key: string, arrangement: Arrangement, shownByDefault: boolean): void {
  state.delete(key);
  if (arrangement.shown === shownByDefault && arrangement.height === null) return;
  state.set(key, arrangement);
  // Deleting from the front of an insertion-ordered Map is how it stays bounded, and it drops the
  // arrangement made longest ago rather than the one just made.
  while (state.size > REMEMBERED_SESSIONS) {
    state.delete(state.keys().next().value as string);
  }
}

/**
 * Shows this session's pane, or hides it. Either way its remembered height stays.
 *
 * Re-reads the store first, and the in-memory map is a cache for rendering rather than the record.
 * Two tabs on this origin are ordinary here -- the panel is read while it is being edited -- and a
 * press that wrote its own map back wholesale would erase every session the OTHER tab had
 * arranged, silently, on a press about something else.
 */
export function toggleTerminalComposer(session: TerminalComposerSession): void {
  const key = sessionKey(session);
  const shownByDefault = session.shownByDefault ?? false;
  const next = load();
  const current = next.get(key);
  arrange(next, key, { shown: !(current?.shown ?? shownByDefault), height: current?.height ?? null }, shownByDefault);
  remembered = next;
  store(next);
  for (const listener of listeners) listener();
}

/** The height this session's pane was last dragged to, or null for one nobody has dragged. */
export function terminalComposerHeight(session: TerminalComposerSession): number | null {
  return remembered.get(sessionKey(session))?.height ?? null;
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
  // Only a pane that is up can be dragged, so a height for one that is not is a write from
  // somewhere that has lost track of it.
  if (!(next.get(key)?.shown ?? session.shownByDefault ?? false)) return;
  // In place rather than through `arrange`: a Map keeps a key's position when its value is
  // replaced, and the press that showed the pane is what recency counts, not every pointer move. A
  // pane shown by default and never pressed goes in at the tail, as `arrange` would put it.
  if (next.has(key)) next.set(key, { shown: true, height: Math.round(height) });
  else arrange(next, key, { shown: true, height: Math.round(height) }, session.shownByDefault ?? false);
  remembered = next;
  store(next);
}

export function useTerminalComposerShown(session: TerminalComposerSession): boolean {
  // Read through the key so the snapshot is a boolean: `useSyncExternalStore` compares snapshots by
  // identity, and handing it the Map would re-render every session's band on any session's press.
  const key = sessionKey(session);
  const shownByDefault = session.shownByDefault ?? false;
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => remembered.get(key)?.shown ?? shownByDefault,
    () => shownByDefault,
  );
}
