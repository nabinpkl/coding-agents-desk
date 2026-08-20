// The calendar's arithmetic: which cells exist, and how dark each one is.
//
// Pure and separate from the component because both answers are easy to get subtly wrong in ways
// a screenshot does not reveal -- an off-by-one weekday shifts the whole grid by a row, and a
// linear intensity ramp makes four months of history look like two dark squares in a pale field.

import type { UsageDay, UsageTotals } from "@agentdesk/agent-feed-wire";

/** 0 is "no usage"; 1 to 4 are the quartiles of the days that had some. */
export type UsageLevel = 0 | 1 | 2 | 3 | 4;

export interface UsageCell {
  date: string;
  /** The day's numbers, or null when nothing ran. */
  day: UsageDay | null;
  /**
   * Whether the scan reaches this date at all.
   *
   * Distinct from a covered day with no usage, and the grid draws them differently: "I did not
   * use Codex that day" and "the history does not go back that far" are different facts, and one
   * swatch for both would quietly turn absence of data into a claim about behaviour.
   */
  covered: boolean;
  level: UsageLevel;
  /** True for a date after today, which the grid leaves as a hole rather than an empty day. */
  future: boolean;
}

export interface UsageGrid {
  /** Oldest week first; each holds exactly 7 cells, Monday through Sunday. */
  weeks: UsageCell[][];
  /** The three quartile boundaries the levels were cut at, for the legend. */
  thresholds: number[];
}

/** What the cell colour encodes: total input volume, cache included. */
export function cellValue(totals: UsageTotals): number {
  return totals.inputTokens;
}

export function uncachedInput(totals: UsageTotals): number {
  return Math.max(0, totals.inputTokens - totals.cachedInputTokens);
}

export function cachedShare(totals: UsageTotals): number {
  return totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0;
}

/** `YYYY-MM-DD` for a local date, the same key the sidecar buckets by. */
export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Monday is row 0. JavaScript puts Sunday at 0, which would start the week on the wrong day. */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - weekdayIndex(start));
  return start;
}

/**
 * Cuts nonzero days into quartiles.
 *
 * Quantiles rather than a linear ramp against the maximum, because usage is not distributed
 * anything like evenly: in one real history the busiest day is forty times a typical one, and a
 * linear scale renders the whole quarter as blank with two dark squares. Quartiles ask "was this
 * a heavy day FOR ME", which is the question a calendar of your own work is being asked.
 */
export function quartileThresholds(values: number[]): number[] {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return [0, 0, 0];
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return [at(0.25), at(0.5), at(0.75)];
}

export function levelFor(value: number, thresholds: number[]): UsageLevel {
  if (value <= 0) return 0;
  if (value < thresholds[0]!) return 1;
  if (value < thresholds[1]!) return 2;
  if (value < thresholds[2]!) return 3;
  return 4;
}

/**
 * Lays out `weeks` columns ending in the week containing `today`.
 *
 * Ends on the current week rather than on the last day with data, so the rightmost column is
 * always "this week" and week-over-week reading does not shift as days pass.
 */
export function buildUsageGrid(
  days: UsageDay[],
  options: { weeks: number; today: Date; coverageFrom: string | null },
): UsageGrid {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const lastWeekStart = startOfWeek(options.today);
  const first = new Date(lastWeekStart);
  first.setDate(first.getDate() - (options.weeks - 1) * 7);

  const todayKey = dateKey(options.today);
  const visible: number[] = [];
  const dates: string[][] = [];
  for (let week = 0; week < options.weeks; week += 1) {
    const column: string[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(first);
      date.setDate(date.getDate() + week * 7 + weekday);
      const key = dateKey(date);
      column.push(key);
      const day = byDate.get(key);
      if (day) visible.push(cellValue(day.totals));
    }
    dates.push(column);
  }

  const thresholds = quartileThresholds(visible);
  const weeks = dates.map((column) => column.map((date): UsageCell => {
    const day = byDate.get(date) ?? null;
    return {
      date,
      day,
      covered: options.coverageFrom !== null && date >= options.coverageFrom && date <= todayKey,
      level: day ? levelFor(cellValue(day.totals), thresholds) : 0,
      future: date > todayKey,
    };
  }));

  return { weeks, thresholds };
}

/** Sums a set of days, for the range header and for one week's column. */
export function sumDays(days: UsageDay[]): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  };
  for (const day of days) {
    totals.inputTokens += day.totals.inputTokens;
    totals.cachedInputTokens += day.totals.cachedInputTokens;
    totals.outputTokens += day.totals.outputTokens;
    totals.reasoningTokens += day.totals.reasoningTokens;
    totals.requests += day.totals.requests;
  }
  return totals;
}

/**
 * Month labels for the columns, placed on the first week whose Monday starts a new month.
 *
 * Returned as a sparse array rather than drawn per column so a month never labels twice.
 */
export function monthLabels(weeks: UsageCell[][]): (string | null)[] {
  let previous = "";
  return weeks.map((week) => {
    const monday = new Date(`${week[0]!.date}T00:00:00`);
    const label = monday.toLocaleDateString(undefined, { month: "short" });
    if (label === previous) return null;
    previous = label;
    return label;
  });
}

/** The Monday and Sunday of the week a date falls in, as `YYYY-MM-DD`. */
export function weekBounds(date: string): { start: string; end: string } {
  const parsed = new Date(`${date}T00:00:00`);
  const start = new Date(parsed);
  start.setDate(start.getDate() - weekdayIndex(parsed));
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: dateKey(start), end: dateKey(end) };
}

/** Shifts a week's bounds back by `count` weeks, for week-over-week reading. */
export function previousWeek(bounds: { start: string; end: string }, count = 1): {
  start: string;
  end: string;
} {
  const start = new Date(`${bounds.start}T00:00:00`);
  start.setDate(start.getDate() - 7 * count);
  return weekBounds(dateKey(start));
}

export function daysInRange(days: UsageDay[], start: string, end: string): UsageDay[] {
  return days.filter((day) => day.date >= start && day.date <= end);
}
