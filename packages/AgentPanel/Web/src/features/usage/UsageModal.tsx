"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { UsageDay, UsageTotals, VendorUsage } from "@agentdesk/agent-feed-wire";
import {
  formatCount,
  formatDay,
  formatPercent,
  formatResetIn,
  formatTokens,
} from "./formatTokens";
import { UsageCalendar, UsageLegend } from "./UsageCalendar";
import {
  buildUsageGrid,
  cachedShare,
  daysInRange,
  dateKey,
  previousWeek,
  sumDays,
  uncachedInput,
  weekBounds,
  type UsageCell,
} from "./usageGrid";
import type { UsageState } from "./useUsage";

const RANGES = [
  { label: "12w", weeks: 12 },
  { label: "26w", weeks: 26 },
  { label: "all", weeks: 0 },
] as const;

const DEFAULT_WEEKS = 26;

export function UsageModal({
  open,
  state,
  onClose,
  now = Date.now,
}: {
  open: boolean;
  state: UsageState;
  onClose: () => void;
  now?: () => number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal?.();
    else if (!open && node.open) node.close?.();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-label="Token usage"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click that lands on it rather than on the
        // panel inside is a click outside.
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[88dvh] w-[min(46rem,92vw)] overflow-hidden rounded-xl border border-border
        bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open ? <UsageModalBody state={state} onClose={onClose} now={now} /> : null}
    </dialog>
  );
}

function UsageModalBody({
  state,
  onClose,
  now,
}: {
  state: UsageState;
  onClose: () => void;
  now: () => number;
}) {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const vendor = state.kind === "ready" ? state.report.vendors[0] ?? null : null;

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Usage
          {vendor ? <span className="ml-2 font-normal text-muted-foreground">{vendor.displayName}</span> : null}
        </h2>
        {vendor?.installed ? (
          <div role="group" aria-label="Range" className="flex items-center gap-0.5">
            {RANGES.map((range) => {
              const value = range.weeks === 0 ? allWeeks(vendor, now) : range.weeks;
              const selected = weeks === value;
              return (
                <button
                  key={range.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setWeeks(value)}
                  className={"rounded-md px-2 py-1 text-xs transition-colors "
                    + "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary "
                    + (selected
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")}
                >
                  {range.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close usage"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground
            transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {state.kind === "error" ? (
          <p className="py-6 text-center text-sm text-destructive">Usage unavailable: {state.message}</p>
        ) : !vendor ? (
          <CalendarSkeleton weeks={weeks} />
        ) : !vendor.installed ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {vendor.displayName} records on this machine.
          </p>
        ) : vendor.days.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {vendor.displayName} has recorded no usage yet.
          </p>
        ) : (
          <VendorPanel
            vendor={vendor}
            weeks={weeks}
            activeDate={activeDate}
            onActivate={setActiveDate}
            now={now}
          />
        )}
      </div>
    </div>
  );
}

function VendorPanel({
  vendor,
  weeks,
  activeDate,
  onActivate,
  now,
}: {
  vendor: VendorUsage;
  weeks: number;
  activeDate: string | null;
  onActivate: (date: string | null) => void;
  now: () => number;
}) {
  const today = useMemo(() => new Date(now()), [now]);
  const grid = useMemo(
    () => buildUsageGrid(vendor.days, { weeks, today, coverageFrom: vendor.coverage.from }),
    [today, vendor.coverage.from, vendor.days, weeks],
  );
  const visibleFrom = grid.weeks[0]![0]!.date;
  const visible = useMemo(
    () => daysInRange(vendor.days, visibleFrom, dateKey(today)),
    [today, vendor.days, visibleFrom],
  );
  const rangeTotals = useMemo(() => sumDays(visible), [visible]);
  const active = activeDate ? vendor.days.find((day) => day.date === activeDate) ?? null : null;

  return (
    <div className="flex flex-col gap-3">
      <TotalsRow label={`Last ${weeks} weeks`} totals={rangeTotals} />
      {vendor.quota ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="text-foreground">{vendor.quota.label}</span>
          <span className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full bg-foreground/60"
              style={{ width: `${Math.min(100, Math.max(0, vendor.quota.usedPercent))}%` }}
            />
          </span>
          <span className="font-mono">{vendor.quota.usedPercent}%</span>
          <span>resets in {formatResetIn(vendor.quota.resetsAt, now())}</span>
          {vendor.quota.planType ? <span>plan {vendor.quota.planType}</span> : null}
        </div>
      ) : null}

      {/* The readout sits ABOVE the grid and always in the same place, rather than floating beside
          the cell. A tooltip anchored to a 12px square has to be positioned, clipped against the
          modal, and duplicated for touch, where there is no hover at all; a fixed readout is the
          same answer for a pointer, a keyboard, and a finger. */}
      <DayReadout day={active} days={vendor.days} />

      <UsageCalendar
        days={vendor.days}
        coverageFrom={vendor.coverage.from}
        weeks={weeks}
        today={today}
        activeDate={activeDate}
        onActivate={onActivate}
        describeCell={describeCell}
      />
      <UsageLegend thresholds={grid.thresholds} />

      {active ? (
        <ul className="flex flex-col gap-1" aria-label="Models used">
          {active.byModel.map((entry) => (
            <li key={entry.model} className="flex items-center gap-2 text-xs">
              <span className="w-40 shrink-0 truncate font-mono text-muted-foreground">{entry.model}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full bg-foreground/50"
                  style={{
                    width: `${active.totals.inputTokens > 0
                      ? (100 * entry.totals.inputTokens) / active.totals.inputTokens
                      : 0}%`,
                  }}
                />
              </span>
              <span className="w-16 shrink-0 text-right font-mono">
                {formatTokens(entry.totals.inputTokens)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {vendor.days.length} days from {formatCount(vendor.coverage.sessions)} sessions
        {vendor.coverage.unreadable > 0
          ? `, ${vendor.coverage.unreadable} unreadable`
          : ""}
        {" · as of "}
        {new Date(vendor.scannedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

/**
 * The numbers a day is made of.
 *
 * Input, cached, and uncached together, because the split is the whole point: on real data the
 * cached share runs from 88% to 99%, so a single input figure is mostly a picture of cache reads.
 */
function TotalsRow({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <dl aria-label={label} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
      <Figure name="input" value={formatTokens(totals.inputTokens)} />
      <Figure
        name="cached"
        value={`${formatTokens(totals.cachedInputTokens)} (${formatPercent(cachedShare(totals))})`}
      />
      <Figure name="uncached" value={formatTokens(uncachedInput(totals))} />
      <Figure name="output" value={formatTokens(totals.outputTokens)} />
      <Figure name="requests" value={formatCount(totals.requests)} />
    </dl>
  );
}

function Figure({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

function DayReadout({ day, days }: { day: UsageDay | null; days: UsageDay[] }) {
  if (!day) {
    return (
      <p className="min-h-9 text-xs text-muted-foreground">
        Hover or focus a day for its input, cached, and uncached totals.
      </p>
    );
  }
  const bounds = weekBounds(day.date);
  const thisWeek = sumDays(daysInRange(days, bounds.start, bounds.end));
  const before = previousWeek(bounds);
  const lastWeek = sumDays(daysInRange(days, before.start, before.end));
  return (
    <div
      role="group"
      aria-label="Selected day"
      className="flex min-h-9 flex-col gap-1 rounded-lg bg-muted/50 px-2 py-1.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-xs font-medium">{formatDay(day.date)}</span>
        <TotalsRow label={`Usage on ${day.date}`} totals={day.totals} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="font-mono">{formatTokens(thisWeek.inputTokens)}</span> that week
        {" ("}
        <span className="font-mono">{formatPercent(cachedShare(thisWeek))}</span> cached), previous
        week <span className="font-mono">{formatTokens(lastWeek.inputTokens)}</span>
        {" ("}
        <span className="font-mono">{formatPercent(cachedShare(lastWeek))}</span> cached)
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

/** Whole weeks from the first recorded day to today, so "all" means all of it. */
function allWeeks(vendor: VendorUsage, now: () => number): number {
  if (!vendor.coverage.from) return DEFAULT_WEEKS;
  const first = weekBounds(vendor.coverage.from).start;
  const elapsed = new Date(now()).getTime() - new Date(`${first}T00:00:00`).getTime();
  return Math.max(1, Math.ceil(elapsed / (7 * 24 * 60 * 60 * 1000)));
}

/** Muted cells at the final dimensions, so nothing reflows when the sweep lands. */
function CalendarSkeleton({ weeks }: { weeks: number }) {
  return (
    <div className="flex gap-[3px] pt-6" aria-label="Loading usage" aria-busy>
      {Array.from({ length: weeks }, (_, week) => (
        <div key={week} className="flex flex-col gap-[3px]">
          {Array.from({ length: 7 }, (_, day) => (
            <span key={day} className="size-3 rounded-[2px] bg-muted" />
          ))}
        </div>
      ))}
    </div>
  );
}
