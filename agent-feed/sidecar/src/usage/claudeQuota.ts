// Claude's rate-limit meter, read from `~/.claude.json`.
//
// Codex stamps `rate_limits` onto the rollout records the sweep is already reading, so its meter
// falls out of the same pass. Claude writes nothing of the kind into a transcript: 288,219 usage
// records carry no limit field, and the only rate-limit trace there is `error: "rate_limit"` on a
// 429, which says a limit was HIT and nothing about where one stands.
//
// Where it does land is `cachedUsageUtilization` in the CLI's own top-level config, holding the
// same two windows a statusline reads (`.rate_limits.five_hour`, `.seven_day`):
//
//   { fetchedAtMs, utilization: { five_hour: { utilization, resets_at }, seven_day: {…},
//                                 limits: [{ kind, percent, resets_at, is_active }], … } }
//
// The field is a CACHE, not a stamp on the last request, and the difference is load-bearing. On
// this machine it read 45 hours old -- utilization 92%, `resets_at` two days in the past -- while
// sessions ran the whole time. So the sample time is carried onto the wire and the panel says how
// old the reading is, rather than presenting a stale meter as the current one.

import { readFile } from "node:fs/promises";
import type { QuotaSample } from "./quotaSample.ts";

/** `five_hour` and `seven_day` are the two the CLI publishes; the rest of the map is nulls. */
const WINDOWS = [
  { key: "five_hour", minutes: 5 * 60 },
  { key: "seven_day", minutes: 7 * 24 * 60 },
] as const;

interface UtilizationWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface ClaudeConfig {
  cachedUsageUtilization?: {
    fetchedAtMs?: number | null;
    utilization?: Record<string, UtilizationWindow | null | undefined>;
  } | null;
}

/**
 * The window closest to its limit, or null when the config names none.
 *
 * The panel has one row and Claude publishes two windows, so one has to be chosen. The most-used
 * one is chosen rather than the shortest, because the question the row answers is "am I about to
 * be stopped", and either window can be the one that stops you: a heavy afternoon runs the
 * five-hour meter up first, a heavy week the seven-day one.
 *
 * Null is a real answer and stays null. A machine that has never had the field written, or whose
 * config cannot be read, gets an empty meter -- not a zero, which would read as "plenty left".
 */
export async function readClaudeQuota(configPath: string): Promise<QuotaSample | null> {
  let parsed: ClaudeConfig;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as ClaudeConfig;
  } catch {
    // Absent, unreadable, or half-written while the CLI rewrites it. The meter is one row of a
    // surface whose subject is the day totals, and taking the whole report down over it would
    // trade the answer for the decoration.
    return null;
  }

  const cached = parsed?.cachedUsageUtilization;
  const utilization = cached?.utilization;
  if (!utilization || typeof utilization !== "object") return null;
  const fetchedAtMs = typeof cached?.fetchedAtMs === "number" && Number.isFinite(cached.fetchedAtMs)
    ? cached.fetchedAtMs
    : 0;

  let best: QuotaSample | null = null;
  for (const window of WINDOWS) {
    const entry = utilization[window.key];
    const percent = entry?.utilization;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (best && percent <= best.usedPercent) continue;
    const resetsAtMs = Date.parse(entry?.resets_at ?? "");
    best = {
      atMs: fetchedAtMs,
      usedPercent: percent,
      windowMinutes: window.minutes,
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : 0,
      // Claude's config names the plan nowhere near this field, and the subscription flags beside
      // it describe entitlements rather than a plan name. Null rather than a guess.
      planType: null,
    };
  }
  return best;
}
