// The ranges a thread holds, read off the rows themselves.
//
// A thread holds any number of contiguous ranges of its transcript, with gaps between them
// (ADR-0125): the live window, a range opened around a row the reader jumped to, rows paged in
// above either. Nothing records where one ends. Every row names the row before it (`previous`), so
// a held row whose previous row is not the held row below it is the first row after a gap, and
// the ranges are derived wherever they are needed rather than kept beside the rows to drift.

import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

export const PAGE_SIZE = 100;

/**
 * The index of the row before `event` in its mode, or null when nothing precedes it.
 *
 * A transcript row says so itself: its index is a byte position, so neighbours are not adjacent
 * numbers. A runtime-backed row does not, because its ordinals are contiguous and the row before
 * index N is N - 1.
 */
export function previousIndex(event: Pick<ActivityEvent, "index" | "previous">): number | null {
  if (event.previous !== undefined) return event.previous;
  return event.index > 0 ? event.index - 1 : null;
}

/** Rows missing between two held rows: `above` is the older held row, `below` the newer one. */
export interface Gap {
  above: number;
  below: number;
}

/** Every gap between the held rows, oldest first. `sorted` is every held row, oldest first. */
export function gapsIn(sorted: readonly Pick<ActivityEvent, "index" | "previous">[]): Gap[] {
  const gaps: Gap[] = [];
  for (let position = 1; position < sorted.length; position += 1) {
    const above = sorted[position - 1]!;
    const below = sorted[position]!;
    const previous = previousIndex(below);
    if (previous !== null && previous > above.index) gaps.push({ above: above.index, below: below.index });
  }
  return gaps;
}

/**
 * Where the oldest held range starts: its first row's index while older rows exist, and 0 once the
 * first row of the session is held. Older paging asks for the page before this.
 */
export function windowStartOf(sorted: readonly Pick<ActivityEvent, "index" | "previous">[]): number {
  const first = sorted[0];
  return first === undefined || previousIndex(first) === null ? 0 : first.index;
}

/** The rows held with a page merged in, keeping whichever copy of a row has the newer revision. */
export function withNewer(
  held: Map<number, ActivityEvent>,
  page: readonly ActivityEvent[],
): Map<number, ActivityEvent> {
  const events = new Map(held);
  for (const event of page) {
    const existing = events.get(event.index);
    if (!existing || (existing.revision ?? 0) < (event.revision ?? 0)) events.set(event.index, event);
  }
  return events;
}
