import type { TokenUsage } from "./useSessionEventsStream";

/** Fill fraction above which the meter reads as a warning rather than a fact. */
const WARN_FRACTION = 0.75;
/** Fill fraction above which compaction is imminent enough to say so loudly. */
const CRITICAL_FRACTION = 0.9;

/**
 * Occupancy as a compact count, with a fill bar when the window is known.
 *
 * This is why `token_count` records no longer take a transcript row of their own:
 * they are 19% of the rows in this project's largest Codex session, and every one
 * supersedes the last, so the whole series collapses to this one live readout.
 *
 * `limit` arrives already resolved from the sidecar, so nothing here maps a model
 * name to a window. When it is null the bar is omitted rather than guessed --
 * a fraction of an invented denominator reads as authoritative and is not.
 */
export function TokenMeter({ usage }: { usage: TokenUsage | null }) {
  if (!usage) return null;

  const compact = formatTokens(usage.current);
  if (usage.limit === null) {
    return (
      <span
        title={`${usage.current.toLocaleString()} tokens in context${usage.model ? ` (${usage.model})` : ""}`}
        aria-label={`Context: ${usage.current.toLocaleString()} tokens`}
        className="shrink-0 px-1 font-mono text-(length:--agent-panel-fs-tile-chip,12px) tabular-nums text-muted-foreground"
      >
        {compact}
      </span>
    );
  }

  const fraction = Math.min(1, Math.max(0, usage.current / usage.limit));
  const percent = Math.round(fraction * 100);
  const tone =
    fraction >= CRITICAL_FRACTION
      ? "text-destructive"
      : fraction >= WARN_FRACTION
        ? "text-amber-500"
        : "text-muted-foreground";
  const fill =
    fraction >= CRITICAL_FRACTION
      ? "bg-destructive"
      : fraction >= WARN_FRACTION
        ? "bg-amber-500"
        : "bg-muted-foreground/60";

  return (
    <span
      title={`${usage.current.toLocaleString()} / ${usage.limit.toLocaleString()} tokens${usage.model ? ` (${usage.model})` : ""}`}
      className="flex shrink-0 flex-col items-end gap-[2px] px-1"
    >
      <span
        className={
          "font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums " +
          tone
        }
      >
        {compact}
      </span>
      {/* The track carries the role and the accessible name, not the wrapper:
          the bar IS the fraction, and naming it here is what makes the readout
          addressable rather than a decorative div. Fixed width so the header
          does not reflow every time the count crosses a digit boundary, which on
          a live thread is every few seconds. */}
      <span
        role="progressbar"
        aria-label={`Context: ${percent}% of ${usage.limit.toLocaleString()} tokens`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-[3px] w-8 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={"block h-full rounded-full " + fill}
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Tokens as at most four glyphs: `812`, `41k`, `183k`, `1.2M`.
 *
 * The header has one line to spend beside a session title that is already
 * truncating, so `183,402` is not an option; the exact figure is in the tooltip
 * and the accessible label.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
