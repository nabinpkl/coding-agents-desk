import type { TokenUsage } from "@/transcripts/transcriptTypes";

/**
 * Fold one line's occupancy report into the session's running total.
 *
 * `current` always takes the newest value -- it is occupancy, not history, and
 * every report supersedes the last. `limit` and `model` are sticky: a report that
 * names neither inherits both, because plenty of records publish occupancy
 * without naming the model that produced it (Codex `token_count`, Claude lines
 * stamped `<synthetic>`), and letting those blank the meter would make it flicker
 * on exactly the records that arrive most often.
 *
 * Pure and stateless so the sticky rule is testable without a transcript; the
 * per-session accumulation lives in the event index, which is the one pass that
 * already sees every line.
 */
export function mergeUsage(
  previous: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  const model = next.model ?? previous?.model;
  // A named model owns its own limit, INCLUDING when that limit is null: a
  // switch to a model this build has no window for has to show a bare count,
  // not the previous model's window applied to a different context size.
  const limit =
    next.model === undefined
      ? next.limit ?? previous?.limit ?? null
      : next.limit;
  return {
    current: next.current,
    limit,
    updatedAt: next.updatedAt,
    ...(model ? { model } : {}),
  };
}
