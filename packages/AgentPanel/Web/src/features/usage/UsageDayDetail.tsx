"use client";

import type { UsageDay, UsageTotals } from "@agentdesk/agent-feed-wire";
import { formatDay, formatPercent, formatTokens } from "@/features/usage/formatTokens";
import { TotalsRow } from "@/features/usage/UsageFigures";
import { cachedShare, daysInRange, previousWeek, sumDays, weekBounds } from "@/features/usage/usageGrid";

/**
 * Rows kept for the per-model list, whether or not a day fills them.
 *
 * Everything in this modal holds its height across every state, because the thing being pointed at
 * is a 12px square: a panel that grew when a day was hovered slid the grid out from under the
 * cursor, which changes which day is hovered. Measured before this was fixed -- hovering a day
 * moved the grid up 8px, and moving on to a two-model day moved it another 10px.
 *
 * Three is where reserving more space stops paying. Across one real history of 107 days, 42 used
 * one model, 35 used two, 18 used three, and 12 used more; that last group scrolls.
 */
const RESERVED_MODEL_ROWS = 3;
const MODEL_ROW_HEIGHT = "1.25rem";
const MODEL_LIST_HEIGHT = `calc(${RESERVED_MODEL_ROWS} * ${MODEL_ROW_HEIGHT} + ${RESERVED_MODEL_ROWS - 1} * 0.25rem)`;

/** Stands in for a day while none is hovered. Rendered invisibly, purely to hold the height. */
const PLACEHOLDER_TOTALS: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  requests: 0,
};

/**
 * The hovered day's figures, in a box that is the same height when no day is hovered.
 *
 * The idle hint and the day's own content share one grid cell. The content is always rendered --
 * invisibly, with zeros, when there is no day -- so the box is as tall empty as full and the
 * calendar below it never moves.
 */
export function DayDetail({ day, days }: { day: UsageDay | null; days: UsageDay[] }) {
  return (
    <div role="group" aria-label="Selected day" className="grid rounded-lg bg-muted/50 px-2 py-1.5">
      <div
        className={`col-start-1 row-start-1 flex flex-col gap-1 ${day ? "" : "invisible"}`}
        aria-hidden={day ? undefined : true}
      >
        <DayFacts day={day} days={days} />
      </div>
      {day ? null : (
        <p className="col-start-1 row-start-1 self-center text-xs text-muted-foreground">
          Hover, focus, or tap a day for its input, cached, and uncached totals.
        </p>
      )}
    </div>
  );
}

function DayFacts({ day, days }: { day: UsageDay | null; days: UsageDay[] }) {
  const totals = day?.totals ?? PLACEHOLDER_TOTALS;
  const bounds = day ? weekBounds(day.date) : null;
  const thisWeek = bounds ? sumDays(daysInRange(days, bounds.start, bounds.end)) : PLACEHOLDER_TOTALS;
  const before = bounds ? previousWeek(bounds) : null;
  const lastWeek = before ? sumDays(daysInRange(days, before.start, before.end)) : PLACEHOLDER_TOTALS;

  return (
    <>
      <span className="h-4 truncate text-xs font-medium">{day ? formatDay(day.date) : "—"}</span>
      <TotalsRow label={day ? `Usage on ${day.date}` : "No day selected"} totals={totals} />
      {/* Two rows, always, at every width. Written as one sentence it wrapped differently
          depending on how many digits the two weeks happened to have. */}
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 text-[11px] text-muted-foreground">
        <dt className="h-4">that week</dt>
        <dd className="h-4 truncate">
          <span className="font-mono text-foreground">{formatTokens(thisWeek.inputTokens)}</span>
          {" input, "}
          <span className="font-mono">{formatPercent(cachedShare(thisWeek))}</span> cached
        </dd>
        <dt className="h-4">previous week</dt>
        <dd className="h-4 truncate">
          <span className="font-mono text-foreground">{formatTokens(lastWeek.inputTokens)}</span>
          {" input, "}
          <span className="font-mono">{formatPercent(cachedShare(lastWeek))}</span> cached
        </dd>
      </dl>
      <ul
        aria-label="Models used"
        className="grid gap-1 overflow-y-auto"
        style={{ height: MODEL_LIST_HEIGHT, gridAutoRows: MODEL_ROW_HEIGHT }}
      >
        {(day?.byModel ?? []).map((entry) => (
          <li key={entry.model} className="flex items-center gap-2 text-xs">
            {/* The alias leads because five rows of `claude-…-…-…` read as one blur at 160px, and
                the exact id is what the row is really keyed by -- so it stays, as the title and as
                the text a screen reader gets, rather than being dropped for the short name. */}
            <span className="w-40 shrink-0 truncate font-mono text-muted-foreground" title={entry.model}>
              {entry.alias ?? entry.model}
              {entry.alias ? <span className="sr-only"> ({entry.model})</span> : null}
            </span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full bg-foreground/50"
                style={{
                  width: `${totals.inputTokens > 0 ? (100 * entry.totals.inputTokens) / totals.inputTokens : 0}%`,
                }}
              />
            </span>
            <span className="w-16 shrink-0 text-right font-mono">{formatTokens(entry.totals.inputTokens)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
