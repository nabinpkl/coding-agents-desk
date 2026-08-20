// The arithmetic of usage, kept away from both the file formats and the HTTP shape.
//
// Totals travel through the cache as tuples rather than objects. 949 sessions is already a
// six-figure count of numbers, and `{"inputTokens":39495,...}` repeated per model per day is most
// of a cache file spent restating five field names.

import type { UsageTotals } from "@agentdesk/agent-feed-wire";

/** `[input, cached, output, reasoning, requests]`, in that order, always. */
export type UsageTuple = [number, number, number, number, number];

/** day (`YYYY-MM-DD`) -> model -> totals. The shape both the scanner and the cache speak. */
export type DayModelTotals = Record<string, Record<string, UsageTuple>>;

export function emptyTuple(): UsageTuple {
  return [0, 0, 0, 0, 0];
}

export function addInto(target: UsageTuple, source: UsageTuple): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index]! += source[index]!;
  }
}

export function toTotals(tuple: UsageTuple): UsageTotals {
  return {
    inputTokens: tuple[0],
    cachedInputTokens: tuple[1],
    outputTokens: tuple[2],
    reasoningTokens: tuple[3],
    requests: tuple[4],
  };
}

/**
 * Folds one session's day/model table into an accumulator covering many sessions.
 *
 * Additive rather than replacing, because one day holds many sessions and one session can span
 * two days. Both directions matter: a session that ran past midnight contributes to two dates,
 * and a date collects from every session that touched it.
 */
export function mergeDayModelTotals(target: DayModelTotals, source: DayModelTotals): void {
  for (const [date, byModel] of Object.entries(source)) {
    const day = (target[date] ??= {});
    for (const [model, tuple] of Object.entries(byModel)) {
      const existing = day[model];
      if (existing) addInto(existing, tuple);
      else day[model] = [...tuple] as UsageTuple;
    }
  }
}

/**
 * The local calendar day a record belongs to, as `YYYY-MM-DD`.
 *
 * Local, not UTC: the question is "what did I spend on Tuesday", and Tuesday is the one the
 * person lived through. Built from the date parts rather than by slicing `toISOString()`, which
 * would silently answer in UTC and move every evening's work to the next day in east-of-Greenwich
 * timezones.
 */
export function localDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
