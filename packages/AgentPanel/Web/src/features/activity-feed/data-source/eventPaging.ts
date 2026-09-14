export const PAGE_SIZE = 100;

/**
 * Returns the offset and limit for seeding the last page of events.
 * Mirrors the seed range math in useSessionEventsStream (lines 67-68).
 */
export function seedRange(
  total: number,
  pageSize = PAGE_SIZE,
): { offset: number; limit: number } {
  const offset = Math.max(0, total - pageSize);
  const limit = total - offset;
  return { offset, limit };
}

/**
 * Returns the targetStart and limit for loading one page of older events.
 * Mirrors the older-range math in useSessionEventsStream (lines 115-116).
 */
export function olderRange(
  currentStart: number,
  pageSize = PAGE_SIZE,
): { targetStart: number; limit: number } {
  const targetStart = Math.max(0, currentStart - pageSize);
  const limit = currentStart - targetStart;
  return { targetStart, limit };
}

/**
 * The page of missing rows nearest the newest end of what is held, or null when what is held has
 * no hole in it.
 *
 * Indices in a mode have no gaps -- measured on a live session in both modes -- so a hole is rows
 * the reader was never sent, not rows that do not exist. What makes one is a reconnect after a
 * stall longer than a window: the snapshot's window starts past the newest row held from before.
 *
 * Newest first, because that is the end the reader is most often at, and each page then lands
 * joined to the rows already on screen rather than as an island in the middle of the hole.
 */
export function newestGap(
  sortedIndices: readonly number[],
  pageSize = PAGE_SIZE,
): { offset: number; limit: number } | null {
  for (let position = sortedIndices.length - 1; position > 0; position -= 1) {
    const above = sortedIndices[position]!;
    const below = sortedIndices[position - 1]!;
    if (above - below <= 1) continue;
    const offset = Math.max(below + 1, above - pageSize);
    return { offset, limit: above - offset };
  }
  return null;
}
