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

/**
 * The page of missing rows nearest the newest end of what is held, or null when what is held has
 * no hole in it.
 *
 * A hole is a held row whose previous row is not the held row below it -- rows the reader was
 * never sent. What makes one is a reconnect after a stall longer than a window: the snapshot's
 * window starts past the newest row held from before. Asked for as the page ending before the
 * row above the hole, so each page lands joined to the rows already on screen, and the next one,
 * if the hole is deeper than a page, is asked for below that.
 *
 * Newest first, because that is the end the reader is most often at.
 */
export function newestGap(
  sorted: readonly Pick<ActivityEvent, "index" | "previous">[],
  pageSize = PAGE_SIZE,
): { before: number; limit: number } | null {
  for (let position = sorted.length - 1; position > 0; position -= 1) {
    const above = sorted[position]!;
    const below = sorted[position - 1]!;
    const previous = previousIndex(above);
    if (previous === null || previous <= below.index) continue;
    return { before: above.index, limit: pageSize };
  }
  return null;
}
