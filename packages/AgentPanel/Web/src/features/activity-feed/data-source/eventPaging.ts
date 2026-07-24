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
