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
