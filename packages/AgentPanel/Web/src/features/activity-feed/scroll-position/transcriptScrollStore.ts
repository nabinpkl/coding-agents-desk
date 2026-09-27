/**
 * Where each session's transcript was left, remembered across visits.
 *
 * An EVENT identity rather than an offset, which is the opposite choice from the canvas's own
 * scroll and for the opposite reason. A pixel into a transcript names nothing on the next visit:
 * the feed is virtualised on estimated row heights until each row is measured, it opens on a
 * window of the newest events rather than the whole thread, and a live session has grown since.
 * The event identity the reader had at the top of the viewport survives all three, because it
 * is what the sidecar's own records are counted by. The index remains as a fallback for older
 * stored entries and for events that have no id.
 *
 * Only the sessions the reader scrolled AWAY from the tail in are held. Following the tail is the
 * default and the majority, and it is restored by doing nothing at all, so an entry for it would
 * be a record of the absence of a choice. A session that returns to the end forgets its entry on
 * the way past, which is also what stops this growing for every session ever read.
 *
 * Capped anyway, because a reader who browses a hundred threads leaves a hundred entries and none
 * of them is worth a store that only grows. The oldest is the one dropped.
 */
export interface TranscriptScrollSession {
  source: string;
  sessionId: string;
}

const STORAGE_KEY = "agent-panel.transcript-scroll";

/** How many sessions keep a remembered place. Oldest out first, so recent reading survives. */
const REMEMBERED_SESSIONS = 64;

export interface TranscriptScrollAnchor {
  /** The event's position in the mode the reader was viewing. */
  index: number;
  /** The event's stable identity when the source provides one. */
  eventId?: string;
}

/** The old two-item shape remains readable so an existing reader does not lose its place on upgrade. */
type StoredAnchor = [key: string, index: number] | [key: string, index: number, eventId: string];
type Anchors = StoredAnchor[];

function sessionKey(session: TranscriptScrollSession): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * Read as a list of pairs rather than an object, so the order entries were written in is the order
 * they come back in and the cap has an oldest to drop.
 */
function load(): Anchors {
  if (typeof window === "undefined") return [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    // Validated rather than cast: a stale or hand-edited shape must fall back to remembering
    // nothing, not scroll a reader to a place no event could be.
    return stored.filter((entry): entry is StoredAnchor => {
      if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3)) return false;
      if (typeof entry[0] !== "string" || !entry[0].includes(":")) return false;
      if (typeof entry[1] !== "number" || !Number.isInteger(entry[1]) || entry[1] < 0) return false;
      return entry.length === 2 ||
        (typeof entry[2] === "string" && entry[2].length > 0 && entry[2].length <= 512);
    });
  } catch {
    return [];
  }
}

function store(anchors: Anchors): void {
  try {
    if (anchors.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(anchors));
  } catch {
    // The feed still reads; it just opens at the tail next time.
  }
}

/** The transcript event this session was last left looking at, or null to follow the tail. */
export function loadTranscriptAnchor(session: TranscriptScrollSession): TranscriptScrollAnchor | null {
  const key = sessionKey(session);
  const stored = load().find(([each]) => each === key);
  if (!stored) return null;
  return stored.length === 3
    ? { index: stored[1], eventId: stored[2] }
    : { index: stored[1] };
}

/**
 * Records where this session is being read.
 *
 * Re-reads the store first, and never writes back a list it held from before. Two tabs on this
 * origin are ordinary here -- the panel is read while it is being edited -- and a write that
 * rebuilt the whole list from one tab's memory would drop every session the other tab had read,
 * silently, on a scroll about something else.
 */
export function rememberTranscriptAnchor(
  session: TranscriptScrollSession,
  event: number,
  eventId?: string,
): void {
  if (!Number.isInteger(event) || event < 0) return;
  const key = sessionKey(session);
  const next = load().filter(([each]) => each !== key);
  next.push(eventId ? [key, event, eventId] : [key, event]);
  // The front is the place read longest ago, so a cap drops that rather than the one just left.
  store(next.slice(-REMEMBERED_SESSIONS));
}

/** This session is at its tail again, so there is nothing left to put back. */
export function forgetTranscriptAnchor(session: TranscriptScrollSession): void {
  const key = sessionKey(session);
  const current = load();
  const next = current.filter(([each]) => each !== key);
  if (next.length === current.length) return;
  store(next);
}
