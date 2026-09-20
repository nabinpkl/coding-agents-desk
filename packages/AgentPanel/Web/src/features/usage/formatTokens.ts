/**
 * Token counts, short enough to sit in a table.
 *
 * Two significant decimals above a million and one above a thousand, because the numbers this
 * renders span six orders of magnitude -- 4 thousand on a quiet day, 1.6 billion on a heavy one --
 * and a raw grouped integer at that width stops being readable as a quantity.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (magnitude >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** `Thu 13 Aug 2026`, in the reader's own locale. */
export function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * How long until a quota window resets, as a coarse duration.
 *
 * Coarse on purpose: a countdown to the second on a weekly window is precision that says nothing,
 * and it would have to re-render every second to stay true.
 */
export function formatResetIn(resetsAt: number, now: number): string {
  const remaining = resetsAt - now;
  if (remaining <= 0) return "now";
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours >= 1) return `${hours}h ${Math.floor((remaining % 3_600_000) / 60_000)}m`;
  return `${Math.max(1, Math.floor(remaining / 60_000))}m`;
}

/**
 * How long ago a reading was taken, as a coarse duration.
 *
 * Exists because the two vendors' quota meters age very differently. Codex stamps its rate limits
 * on the newest rollout record, so a sample is minutes old at worst; Claude's comes from a config
 * cache the CLI refreshes on its own schedule, measured 45 hours stale on a machine that had run
 * sessions throughout. A reader shown 92% with no age would take a two-day-old meter as current.
 */
export function formatAge(sampledAt: number, now: number): string {
  const elapsed = Math.max(0, now - sampledAt);
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d old`;
  if (hours >= 1) return `${hours}h old`;
  return `${Math.floor(elapsed / 60_000)}m old`;
}

/** A quota reading older than this is reported by its age instead of by its reset. */
export const STALE_QUOTA_MS = 60 * 60 * 1000;

/**
 * A quota window as the two or three glyphs the composer has room for: `5h`, `7d`, `30m`.
 *
 * The long form (`quotaLabel` in the sidecar, "5-hour limit") names a row in a popover that has a
 * line to spend on it. This names a chip sitting next to the context count on a card that is
 * already a narrow column, where "5-hour limit 25%" would push the count off the end.
 */
export function formatWindow(windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return "limit";
  if (windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${Math.round(windowMinutes)}m`;
}
