import type { ActivityEvent, TokenUsage } from "@/features/activity-feed/useSessionEventsStream";

/** Whichever occupancy report is more recent, by the timestamp on the line that
 *  produced it. Both are already-resolved snapshots, so this picks rather than
 *  merges -- with one exception: the cache lifetime is carried over when the
 *  winner names none. A request that wrote nothing to the cache reports no
 *  lifetime, which says the request was a pure hit, not that the cache stopped
 *  having one, and picking it wholesale would drop the countdown on the rows
 *  that arrive most often. */
export function newerUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  const [older, newer] = right.updatedAt >= left.updatedAt ? [left, right] : [right, left];
  if (newer.cacheTtlMs !== undefined || older.cacheTtlMs === undefined) return newer;
  return { ...newer, cacheTtlMs: older.cacheTtlMs };
}

/**
 * Last usage-bearing transcript entry among the events, or null when none.
 *
 * The sidecar folds `token_count` lines and assistant-message usage fields into
 * a per-event "Token Usage" metadata row. When the structured occupancy field
 * (`u` on a thread chunk) is absent -- an older sidecar, a runtime that did not
 * relay it -- the seed still carries the transcript's own last reading, and the
 * meter can initialize from it instead of staying empty until the first live
 * update. Live readings still win later: their `updatedAt` is newer, so the
 * `newerUsage` merge replaces this fallback rather than competing with it.
 */
export function lastUsageFromEvents(events: ActivityEvent[]): TokenUsage | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    for (let blockIndex = event.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = event.blocks[blockIndex]!;
      if (block.kind !== "metadata" || block.label !== "Token Usage" || !block.text) continue;
      const parsed = parseUsageText(block.text);
      if (!parsed) continue;
      return { current: parsed.current, limit: parsed.limit, updatedAt: event.ts };
    }
  }
  return null;
}

/**
 * Parse the two renderings the adapters publish, in whatever locale digits:
 * Claude's `"71,411 tokens"` (current only) and Codex's
 * `"1,234 / 200,000 tokens"` (current and window). Returns null for anything
 * else rather than guessing.
 */
export function parseUsageText(text: string): { current: number; limit: number | null } | null {
  const cleaned = text.replace(/[,\s]/g, "");
  const match = /^(\d+)(?:\/(\d+))?tokens?$/i.exec(cleaned);
  if (!match) return null;
  const current = Number(match[1]);
  if (!Number.isSafeInteger(current)) return null;
  const rawLimit = match[2];
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) return null;
  return { current, limit };
}
