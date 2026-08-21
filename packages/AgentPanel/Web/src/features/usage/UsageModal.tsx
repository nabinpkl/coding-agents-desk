"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { UsageDay, UsageQuota, UsageTotals, VendorUsage } from "@agentdesk/agent-feed-wire";
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
const MODEL_LIST_HEIGHT =
  `calc(${RESERVED_MODEL_ROWS} * ${MODEL_ROW_HEIGHT} + ${RESERVED_MODEL_ROWS - 1} * 0.25rem)`;

/** Stands in for a day while none is hovered. Rendered invisibly, purely to hold the height. */
const PLACEHOLDER_TOTALS: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  requests: 0,
};

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
  // The first sweep on a cold cache reads gigabytes and takes seconds. The panel is drawn at its
  // final size throughout and withholds the figures rather than the layout, so nothing moves when
  // the report finally lands.
  const loading = state.kind === "loading" || state.kind === "idle";

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Usage
          {vendor ? <span className="ml-2 font-normal text-muted-foreground">{vendor.displayName}</span> : null}
        </h2>
        {loading || vendor?.installed ? (
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
        ) : vendor && !vendor.installed ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {vendor.displayName} records on this machine.
          </p>
        ) : vendor && vendor.days.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {vendor.displayName} has recorded no usage yet.
          </p>
        ) : (
          <VendorPanel
            vendor={vendor}
            loading={loading}
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

/**
 * The numbers a bucket is made of.
 *
 * Input, cached, and uncached together, because the split is the whole point: on real data the
 * cached share runs from 88% to 99%, so a single input figure is mostly a picture of cache reads.
 *
 * A fixed-column grid rather than a wrapping row. These figures change width with their digits --
 * "4.00M" against "485.22M" -- and a wrapping row re-flowed from one line to two as the pointer
 * moved between days, which is the same layout shift arriving by a different route.
 */
function TotalsRow({
  label,
  totals,
  withheld = false,
}: {
  label: string;
  totals: UsageTotals;
  withheld?: boolean;
}) {
  const show = (value: string) => (withheld ? "—" : value);
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
      <Figure name="input" value={show(formatTokens(totals.inputTokens))} />
      {/* The share rides the LABEL, not the value. As part of the value the cached figure was half
          again as wide as any other and was the one that truncated at phone width, which is the
          worst possible figure to cut: it is the one the calendar exists to show. */}
      <Figure
        name={withheld ? "cached" : `cached (${formatPercent(cachedShare(totals))})`}
        value={show(formatTokens(totals.cachedInputTokens))}
      />
      <Figure name="uncached" value={show(formatTokens(uncachedInput(totals)))} />
      <Figure name="output" value={show(formatTokens(totals.outputTokens))} />
      <Figure name="requests" value={show(formatCount(totals.requests))} />
    </dl>
  );
}

/**
 * One figure: a small muted label with its number under it.
 *
 * Stacked at every width, which is the only arrangement that fits. Side by side, a label and a
 * token count need about 135px and the widest layout here gives a column 129px, so the figure that
 * overflowed was `cached` -- the one this whole surface exists to show. Stacked, a column has to
 * fit only the longer of the two, and the row keeps a fixed line count so it cannot reflow as the
 * numbers change.
 */
function Figure({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="h-4 truncate text-muted-foreground">{name}</dt>
      <dd className="h-4 truncate font-mono text-foreground">{value}</dd>
    </div>
  );
}

/** One row tall whether or not the vendor publishes a limit, so its absence moves nothing. */
function QuotaRow({ quota, now }: { quota: UsageQuota | null; now: () => number }) {
  // Two lines at phone width, one from `sm` up, both fixed: the row's contents do not change while
  // a day is hovered, but a height that depended on how they wrapped would still move the grid on
  // the first render after a report landed.
  if (!quota) return <div className="h-8 sm:h-4" aria-hidden />;
  return (
    <div className="flex h-8 flex-wrap items-center gap-x-3 overflow-hidden text-xs text-muted-foreground sm:h-4">
      <span className="shrink-0 text-foreground">{quota.label}</span>
      <span className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full bg-foreground/60"
          style={{ width: `${Math.min(100, Math.max(0, quota.usedPercent))}%` }}
        />
      </span>
      <span className="shrink-0 font-mono">{quota.usedPercent}%</span>
      <span className="shrink-0">resets in {formatResetIn(quota.resetsAt, now())}</span>
      {quota.planType ? <span className="truncate">plan {quota.planType}</span> : null}
    </div>
  );
}

/**
 * The hovered day's figures, in a box that is the same height when no day is hovered.
 *
 * The idle hint and the day's own content share one grid cell. The content is always rendered --
 * invisibly, with zeros, when there is no day -- so the box is as tall empty as full and the
 * calendar below it never moves.
 */
function DayDetail({ day, days }: { day: UsageDay | null; days: UsageDay[] }) {
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
            <span className="w-40 shrink-0 truncate font-mono text-muted-foreground">{entry.model}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full bg-foreground/50"
                style={{
                  width: `${totals.inputTokens > 0
                    ? (100 * entry.totals.inputTokens) / totals.inputTokens
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
    </>
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
function allWeeks(vendor: VendorUsage | null, now: () => number): number {
  if (!vendor?.coverage.from) return DEFAULT_WEEKS;
  const first = weekBounds(vendor.coverage.from).start;
  const elapsed = new Date(now()).getTime() - new Date(`${first}T00:00:00`).getTime();
  return Math.max(1, Math.ceil(elapsed / (7 * 24 * 60 * 60 * 1000)));
}
