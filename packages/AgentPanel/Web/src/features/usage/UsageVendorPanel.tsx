"use client";

import { useMemo } from "react";
import type { VendorUsage } from "@agentdesk/agent-feed-wire";
import { formatCount, formatDay, formatPercent, formatTokens } from "@/features/usage/formatTokens";
import { UsageCalendar, UsageLegend } from "@/features/usage/UsageCalendar";
import { DayDetail } from "@/features/usage/UsageDayDetail";
import { TotalsRow } from "@/features/usage/UsageFigures";
import { QuotaRow } from "@/features/usage/UsageQuotaRow";
import {
  buildUsageGrid,
  cachedShare,
  daysInRange,
  dateKey,
  sumDays,
  uncachedInput,
  type UsageCell,
} from "@/features/usage/usageGrid";

export function VendorPanel({
  vendor,
  loading,
  weeks,
  activeDate,
  onActivate,
  now,
}: {
  vendor: VendorUsage | null;
  loading: boolean;
  weeks: number;
  activeDate: string | null;
  onActivate: (date: string | null) => void;
  now: () => number;
}) {
  const today = useMemo(() => new Date(now()), [now]);
  const days = vendor?.days ?? [];
  const coverageFrom = vendor?.coverage.from ?? null;
  const grid = useMemo(
    () => buildUsageGrid(days, { weeks, today, coverageFrom }),
    [coverageFrom, days, today, weeks],
  );
  const visibleFrom = grid.weeks[0]![0]!.date;
  const visible = useMemo(
    () => daysInRange(days, visibleFrom, dateKey(today)),
    [days, today, visibleFrom],
  );
  const rangeTotals = useMemo(() => sumDays(visible), [visible]);
  // The most recent recorded day stands in when nothing is pointed at, including when the pointer
  // leaves the grid. Every state then shows a real day, which is both the more useful thing to
  // open on and the reason the panel is never a reserved rectangle of empty space.
  const active = (activeDate ? days.find((day) => day.date === activeDate) : undefined)
    ?? days.at(-1)
    ?? null;

  return (
    <div className="flex flex-col gap-3" aria-busy={loading || undefined}>
      <TotalsRow label={`Last ${weeks} weeks`} totals={rangeTotals} withheld={loading} />
      <QuotaRow quota={vendor?.quota ?? null} now={now} />

      {/* The day's figures sit ABOVE the grid and always in the same place, rather than floating
          beside the cell. A tooltip anchored to a 12px square has to be positioned, clipped against
          the modal, and duplicated for touch, where there is no hover at all; a fixed readout is
          one answer for a pointer, a keyboard, and a finger -- and it cannot move the thing being
          pointed at, which a panel that grew on hover did. */}
      <DayDetail day={active} days={days} />

      <UsageCalendar
        days={days}
        coverageFrom={coverageFrom}
        weeks={weeks}
        today={today}
        activeDate={active?.date ?? null}
        onActivate={onActivate}
        describeCell={describeCell}
      />
      <UsageLegend thresholds={grid.thresholds} />

      <p className="h-4 truncate text-[11px] text-muted-foreground">
        {vendor && !loading
          ? `${days.length} days from ${formatCount(vendor.coverage.sessions)} sessions`
            + (vendor.coverage.unreadable > 0 ? `, ${vendor.coverage.unreadable} unreadable` : "")
            + ` · as of ${new Date(vendor.scannedAt).toLocaleTimeString()}`
          : "Reading session records…"}
      </p>
    </div>
  );
}

/** The same numbers the readout shows, for a screen reader on one cell. */
function describeCell(cell: UsageCell): string {
  if (cell.future) return "";
  if (!cell.covered) return `${formatDay(cell.date)}: outside the recorded history`;
  if (!cell.day) return `${formatDay(cell.date)}: no usage`;
  const totals = cell.day.totals;
  return `${formatDay(cell.date)}: ${formatTokens(totals.inputTokens)} input, `
    + `${formatTokens(totals.cachedInputTokens)} cached (${formatPercent(cachedShare(totals))}), `
    + `${formatTokens(uncachedInput(totals))} uncached, `
    + `${formatTokens(totals.outputTokens)} output, ${formatCount(totals.requests)} requests`;
}
