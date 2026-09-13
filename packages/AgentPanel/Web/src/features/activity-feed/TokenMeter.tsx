import { useEffect, useState } from "react";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";

/** Fill fraction above which the meter reads as a warning rather than a fact. */
const WARN_FRACTION = 0.75;
/** Fill fraction above which compaction is imminent enough to say so loudly. */
const CRITICAL_FRACTION = 0.9;
/**
 * Occupancy above which compacting has paid for itself inside one more user turn.
 *
 * A second reason to warn, because the fractions above answer a different question. They are about
 * running OUT -- the window ending, and compaction happening whether or not anyone chose it -- and
 * on a 1M window that leaves the meter grey from 150k to 750k, which is the entire range where
 * compacting is the cheaper move. The two share a colour because they share an action.
 *
 * Measured on this project's own transcripts, in base-input-token units at $5.00/MTok (cache read
 * 0.1x, 1h cache write 2.0x, output 5.0x):
 *
 * - Compacting costs about 144,800 units, roughly $0.72, and that figure is FLAT in context size.
 *   The summariser reads the whole context too, so its `0.1 x C` term cancels against continuing;
 *   what is left is the summary's output and the next turn's rewrite of a fresh prefix.
 * - Every later request then saves `0.1 x (C - 83k)`, 83k being the measured size a compacted
 *   context comes back at. The gap never closes: both branches grow at the same rate.
 * - So break-even is `debt / saving` requests, and this session runs 11.7 API requests per user
 *   turn. At 200k that is 12.4 requests, which is one turn. At 500k it is under four.
 *
 * A model with a 200k window can never reach this, and does not need to: its fractions fire first.
 */
const COMPACTION_PAYS_ABOVE = 200_000;
/**
 * What the amber means once the count has passed that line, on the tooltip and on the bar's
 * accessible name.
 *
 * Both, rather than the tooltip alone: colour is the only other thing carrying this, and a reader
 * who cannot see the colour would otherwise have no way to the state at all.
 */
const COSTLY_NOTE = " \u00b7 compacting now pays for itself within a turn";
/** Minutes of cache left below which the countdown stops being a fact and starts
 *  being a warning. Ten because the thing it is warning about takes a minute or
 *  two to act on: compacting while warm is what makes the next message cheap. */
const CACHE_WARN_MINUTES = 10;
/** How often the countdown re-reads the clock. It renders whole minutes, so this
 *  only bounds how stale the displayed minute can be, and every session header on
 *  screen pays it. */
const CACHE_TICK_MS = 15_000;

/** Whole minutes until the prompt cache behind this context expires, or null when
 *  the sidecar published no lifetime for it. Floors at zero and stays there: an
 *  expired cache does not get more expired, and the next request is what moves it. */
function minutesOfCacheLeft(usage: TokenUsage, now: number): number | null {
  if (!usage.cacheTtlMs) return null;
  const remaining = usage.updatedAt + usage.cacheTtlMs - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / 60_000);
}

/**
 * Minutes of prompt cache left, beside the occupancy count.
 *
 * It is here because the step it counts down to is a 20x one and nothing else on
 * the surface shows it: a context that is still cached re-reads at 0.1x base
 * input, and one that has expired rewrites at 2.0x, paid in full on the next
 * message. A 500k session that sleeps through its hour pays about ten times what
 * the same message costs while warm, and the transcript looks identical either
 * way.
 */
function CacheCountdown({ usage }: { usage: TokenUsage }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CACHE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const minutes = minutesOfCacheLeft(usage, now);
  if (minutes === null) return null;
  const tone =
    minutes === 0
      ? "text-destructive"
      : minutes <= CACHE_WARN_MINUTES
        ? "text-amber-500"
        : "text-muted-foreground/70";
  return (
    <span
      title={
        minutes === 0
          ? "Prompt cache expired: the next message rewrites the whole context"
          : `Prompt cache expires in ${minutes} min`
      }
      aria-label={`Prompt cache: ${minutes} minutes left`}
      className={
        "font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums " +
        tone
      }
    >
      {minutes}m
    </span>
  );
}

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
  // Nothing here divides by the window, which is why the cost warning survives a session with no
  // window at all: what compacting saves is a property of the context's SIZE, not of how much room
  // is left beside it.
  const costly = usage.current >= COMPACTION_PAYS_ABOVE;
  if (usage.limit === null) {
    return (
      <span className="flex shrink-0 items-baseline gap-1 px-1">
        <CacheCountdown usage={usage} />
        <span
          title={`${usage.current.toLocaleString()} tokens in context${usage.model ? ` (${usage.model})` : ""}${costly ? COSTLY_NOTE : ""}`}
          aria-label={`Context: ${usage.current.toLocaleString()} tokens`}
          className={
            "font-mono text-(length:--agent-panel-fs-tile-chip,12px) tabular-nums "
            + (costly ? "text-amber-500" : "text-muted-foreground")
          }
        >
          {compact}
        </span>
      </span>
    );
  }

  const fraction = Math.min(1, Math.max(0, usage.current / usage.limit));
  const percent = Math.round(fraction * 100);
  const tone =
    fraction >= CRITICAL_FRACTION
      ? "text-destructive"
      : fraction >= WARN_FRACTION || costly
        ? "text-amber-500"
        : "text-muted-foreground";
  // Deliberately not `costly`, unlike the count above it. The track is how FULL the window is, and
  // an amber track on a bar drawn at 30% says the window is nearly gone, which is not what the
  // cost line means. The count is the size, and the size is what compacting is about.
  const fill =
    fraction >= CRITICAL_FRACTION
      ? "bg-destructive"
      : fraction >= WARN_FRACTION
        ? "bg-amber-500"
        : "bg-muted-foreground/60";

  return (
    <span
      title={`${usage.current.toLocaleString()} / ${usage.limit.toLocaleString()} tokens${usage.model ? ` (${usage.model})` : ""}${costly ? COSTLY_NOTE : ""}`}
      className="flex shrink-0 flex-col items-end gap-[2px] px-1"
    >
      {/* Countdown first so the count keeps the right edge, directly over the
          track below it: the occupancy and its bar are one reading and stay
          aligned, and the cache clock sits beside them rather than between. */}
      <span className="flex items-baseline gap-1">
        <CacheCountdown usage={usage} />
        <span
          className={
            "font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums " +
            tone
          }
        >
          {compact}
        </span>
      </span>
      {/* The track carries the role and the accessible name, not the wrapper:
          the bar IS the fraction, and naming it here is what makes the readout
          addressable rather than a decorative div. Fixed width so the header
          does not reflow every time the count crosses a digit boundary, which on
          a live thread is every few seconds. */}
      <span
        role="progressbar"
        aria-label={`Context: ${percent}% of ${usage.limit.toLocaleString()} tokens${costly ? COSTLY_NOTE : ""}`}
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
