import { describe, expect, it } from "vitest";
import type { UsageDay, UsageTotals } from "@agentdesk/agent-feed-wire";
import {
  buildUsageGrid,
  cachedShare,
  dateKey,
  daysInRange,
  levelFor,
  monthLabels,
  previousWeek,
  quartileThresholds,
  sumDays,
  uncachedInput,
  weekBounds,
  weekdayIndex,
} from "@/features/usage/usageGrid";

function totals(input: number, cached = 0): UsageTotals {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: Math.round(input / 100),
    reasoningTokens: 0,
    requests: 1,
  };
}

function day(date: string, input: number, cached = 0): UsageDay {
  return { date, totals: totals(input, cached), byModel: [{ model: "m", alias: null, totals: totals(input, cached) }] };
}

/** A Wednesday, so an off-by-one in the weekday mapping cannot pass unnoticed. */
const WEDNESDAY = new Date(2026, 7, 19, 12);

describe("cache arithmetic", () => {
  it("derives uncached input rather than storing it", () => {
    // The wire carries input and cached; the third number is always the difference. A stored
    // third number is one that can disagree with its own inputs.
    expect(uncachedInput(totals(39_495, 6_912))).toBe(32_583);
    expect(cachedShare(totals(100, 98))).toBeCloseTo(0.98);
  });

  it("never reports negative uncached input", () => {
    // Defends the display, not the data: a vendor that ever published cached > input would render
    // a minus sign next to a token count, which reads as a bug in the panel.
    expect(uncachedInput(totals(10, 20))).toBe(0);
  });

  it("reports no cached share for a day with no input", () => {
    expect(cachedShare(totals(0, 0))).toBe(0);
  });
});

describe("levels", () => {
  it("cuts nonzero days at their own quartiles", () => {
    // Not a linear ramp against the maximum. On real data the busiest day is forty times a
    // typical one, and a linear scale renders a whole quarter blank with two dark squares.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 100, 1_000_000];
    const thresholds = quartileThresholds(values);
    expect(levelFor(0, thresholds)).toBe(0);
    expect(levelFor(1, thresholds)).toBe(1);
    expect(levelFor(1_000_000, thresholds)).toBe(4);
    // The point of quartiles: an ordinary day is not flattened to nothing by one huge one.
    expect(levelFor(5, thresholds)).toBeGreaterThan(1);
  });

  it("has no levels to cut when nothing ran", () => {
    expect(quartileThresholds([0, 0])).toEqual([0, 0, 0]);
    expect(levelFor(0, [0, 0, 0])).toBe(0);
  });
});

describe("grid layout", () => {
  it("puts Monday in row 0", () => {
    expect(weekdayIndex(new Date(2026, 7, 17))).toBe(0);
    expect(weekdayIndex(new Date(2026, 7, 23))).toBe(6);
  });

  it("ends on the week containing today, so the last column is always this week", () => {
    const grid = buildUsageGrid([], { weeks: 4, today: WEDNESDAY, coverageFrom: null });
    expect(grid.weeks).toHaveLength(4);
    for (const week of grid.weeks) expect(week).toHaveLength(7);
    expect(grid.weeks.at(-1)![0]!.date).toBe("2026-08-17");
    expect(grid.weeks[0]![0]!.date).toBe("2026-07-27");
  });

  it("tells an unrecorded day apart from a recorded empty one", () => {
    // Two different facts, and one swatch for both would turn absence of data into a claim about
    // behaviour: "I did not use Codex that day" is not "the history does not go back that far".
    const grid = buildUsageGrid([day("2026-08-18", 100)], {
      weeks: 2,
      today: WEDNESDAY,
      coverageFrom: "2026-08-17",
    });
    const cells = grid.weeks.flat();
    const before = cells.find((cell) => cell.date === "2026-08-14")!;
    const empty = cells.find((cell) => cell.date === "2026-08-17")!;
    expect(before.covered).toBe(false);
    expect(empty.covered).toBe(true);
    expect(empty.day).toBeNull();
  });

  it("leaves the rest of this week as future, not as empty days", () => {
    const grid = buildUsageGrid([], { weeks: 1, today: WEDNESDAY, coverageFrom: "2026-01-01" });
    const cells = grid.weeks[0]!;
    expect(cells.find((cell) => cell.date === "2026-08-19")!.future).toBe(false);
    expect(cells.find((cell) => cell.date === "2026-08-20")!.future).toBe(true);
  });

  it("carries a day's numbers on its cell", () => {
    const grid = buildUsageGrid([day("2026-08-18", 500, 490)], {
      weeks: 1,
      today: WEDNESDAY,
      coverageFrom: "2026-08-01",
    });
    const cell = grid.weeks[0]!.find((entry) => entry.date === "2026-08-18")!;
    expect(cell.day?.totals.inputTokens).toBe(500);
    expect(cell.level).toBe(4);
  });

  it("labels a month once, on the week that starts it", () => {
    const grid = buildUsageGrid([], { weeks: 8, today: WEDNESDAY, coverageFrom: null });
    const labels = monthLabels(grid.weeks).filter((label): label is string => label !== null);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("formats a date key from local parts, matching the sidecar's buckets", () => {
    // Never `toISOString().slice(0, 10)`, which answers in UTC and moves an evening's work to the
    // next day everywhere east of Greenwich.
    expect(dateKey(new Date(2026, 7, 19, 23, 45))).toBe("2026-08-19");
  });
});

describe("week comparison", () => {
  it("bounds a week from Monday to Sunday", () => {
    expect(weekBounds("2026-08-19")).toEqual({ start: "2026-08-17", end: "2026-08-23" });
    expect(weekBounds("2026-08-23")).toEqual({ start: "2026-08-17", end: "2026-08-23" });
  });

  it("steps back a whole week for the previous one", () => {
    expect(previousWeek(weekBounds("2026-08-19"))).toEqual({
      start: "2026-08-10",
      end: "2026-08-16",
    });
  });

  it("sums a range inclusively at both ends", () => {
    const days = [day("2026-08-16", 1), day("2026-08-17", 10, 5), day("2026-08-23", 100)];
    const week = daysInRange(days, "2026-08-17", "2026-08-23");
    expect(week.map((entry) => entry.date)).toEqual(["2026-08-17", "2026-08-23"]);
    expect(sumDays(week)).toEqual({
      inputTokens: 110,
      cachedInputTokens: 5,
      outputTokens: 1,
      reasoningTokens: 0,
      requests: 2,
    });
  });

  it("sums nothing to zeroes rather than to nothing", () => {
    expect(sumDays([]).inputTokens).toBe(0);
    expect(sumDays([]).requests).toBe(0);
  });
});
