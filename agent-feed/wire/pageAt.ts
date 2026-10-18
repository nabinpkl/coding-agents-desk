// Where a page of a session's rows is read from: before a position, after one, or around one.
//
// One shape for both ends because it is a query string on one side and a parse on the other, and
// the two disagreeing is a page read from the wrong place with nothing to say so. A transcript row
// is named by the byte its line starts at (ADR-0124), so any of these is one bounded read wherever
// the position is; a runtime-backed row is an ordinal, and the sidecar answers by arithmetic.

/**
 * - `before`: the newest rows below the row at that position, or the newest of all when null.
 * - `after`: the oldest rows above the row at that position, not including it.
 * - `around`: the row at that position with rows either side, for landing on it (ADR-0125).
 */
export type EventsPageAt = { before: number | null } | { after: number } | { around: number };

/** The query parameter that says where, or "" for the newest page. */
export function eventsPageAtQuery(at: EventsPageAt): string {
  if ("after" in at) return `after=${at.after}`;
  if ("around" in at) return `around=${at.around}`;
  return at.before === null ? "" : `before=${at.before}`;
}

/**
 * Where a request asked to read from: the newest page when it names no position, and null when it
 * names more than one or one that is not a whole number, which a route answers with a 400 rather
 * than guessing which was meant.
 */
export function eventsPageAtFromQuery(params: URLSearchParams): EventsPageAt | null {
  const named = (["before", "after", "around"] as const).filter((key) => params.has(key));
  if (named.length === 0) return { before: null };
  if (named.length > 1) return null;
  const key = named[0]!;
  const raw = params.get(key)!;
  if (!/^\d+$/.test(raw)) return null;
  const position = Number(raw);
  if (!Number.isSafeInteger(position)) return null;
  if (key === "after") return { after: position };
  if (key === "around") return { around: position };
  return { before: position };
}
