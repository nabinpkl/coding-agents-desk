// Claude's rate-limit meters as the CLI last wrote them down, which is the FALLBACK source.
//
// The live one is `claudeLiveQuota.ts`, reading the same numbers off response headers as they
// cross the proxy. This file reads what is on disk, for the windows where nothing has crossed it:
// a sidecar that has just started, or a machine whose Claude traffic is not proxied.
//
// Codex stamps `rate_limits` onto the rollout records the sweep is already reading, so its meter
// falls out of the same pass. Claude writes nothing of the kind into a transcript: 288,219 usage
// records carry no limit field, and the only rate-limit trace there is `error: "rate_limit"` on a
// 429, which says a limit was HIT and nothing about where one stands.
//
// What it does write, sometimes, is `cachedUsageUtilization` in its own top-level config:
// `{ fetchedAtMs, accountUuid, utilization: { five_hour: { utilization, resets_at }, seven_day:
// {...}, seven_day_opus: {...} } }`. The CLI writes it only when its in-memory copy has gone
// stale, drops it on logout, and ignores it when the account it was written for is not the
// current one -- so it is absent for long stretches. Measured 2026-09-15 on this machine (CLI
// 2.1.273): absent from `~/.claude.json` entirely, and from all five rotated backups of it, while
// sessions ran all day. That measurement is why this file is the fallback and not the source.
//
// It is read and never written. Nothing here, or anywhere else in this tree, modifies a file
// Claude owns; see AGENTS.md, "Claude's own files are read-only, and its credentials are off
// limits".
//
// Two unit traps, both settled by reading the CLI rather than by assuming, because both are
// silent when wrong:
//
//   - `utilization` is a FRACTION. The CLI's header parser clamps it with
//     `Math.max(0, Math.min(1, s))` and its near-limit hint compares it against 0.95, and the
//     statusline payload is built by multiplying it by 100. Read as a percent, a window at 92%
//     renders as 1%.
//   - `resets_at` is epoch SECONDS (the CLI tests it as `resets_at * 1000 > Date.now()`). An ISO
//     string is accepted too, since the file's shape is not ours and an older CLI wrote one.

import { readFile } from "node:fs/promises";
import { orderQuotas, type QuotaSample } from "@/usage/quotaSample";

/**
 * The windows the CLI publishes, and what each one meters.
 *
 * `seven_day_overage_included`, `overage` and the experiment-gated windows beside them are
 * deliberately absent: they measure a credit balance rather than a rate limit, and a row reading
 * "Weekly limit" against a balance would be a different number wearing the same name.
 */
const WINDOWS = [
  { key: "five_hour", minutes: 5 * 60, scope: null },
  { key: "seven_day", minutes: 7 * 24 * 60, scope: null },
  { key: "seven_day_opus", minutes: 7 * 24 * 60, scope: "Opus" },
  { key: "seven_day_sonnet", minutes: 7 * 24 * 60, scope: "Sonnet" },
] as const;

/** One window as the config cache spells it. */
interface WindowReading {
  /** A fraction between 0 and 1. */
  utilization?: number | null;
  /** Epoch seconds, or an ISO timestamp from an older CLI. */
  resets_at?: number | string | null;
}

interface ClaudeConfig {
  cachedUsageUtilization?: {
    fetchedAtMs?: number | null;
    utilization?: Record<string, WindowReading | null | undefined>;
  } | null;
}

/**
 * Every window the CLI's config names a reading for, shortest window first.
 *
 * An empty list is a real answer and stays empty. A zero would render as a meter with plenty
 * left, which is a claim; nothing renders as no meter, which is the truth.
 */
export async function readClaudeQuotas(configPath: string): Promise<QuotaSample[]> {
  const parsed = await readJson<ClaudeConfig>(configPath);
  const cached = parsed?.cachedUsageUtilization;
  if (!cached?.utilization || typeof cached.utilization !== "object") return [];
  return orderQuotas(collect(cached.utilization, stamp(cached.fetchedAtMs)));
}

function collect(windows: Record<string, WindowReading | null | undefined>, fetchedAtMs: number): QuotaSample[] {
  const samples: QuotaSample[] = [];
  for (const window of WINDOWS) {
    const reading = windows[window.key];
    const percent = usedPercent(reading);
    if (percent === null) continue;
    samples.push({
      atMs: fetchedAtMs,
      usedPercent: percent,
      windowMinutes: window.minutes,
      resetsAtMs: resetsAt(reading?.resets_at),
      // Claude's own files name the plan nowhere near these fields, and the subscription flags
      // beside them describe entitlements rather than a plan name. Null rather than a guess.
      planType: null,
      scope: window.scope,
    });
  }
  return samples;
}

/** Whole percent, from the fraction the config stores. */
function usedPercent(reading: WindowReading | null | undefined): number | null {
  if (!reading) return null;
  const utilization = reading.utilization;
  // The CLI's own units: a fraction, which is why this is the one place a 100 appears.
  if (typeof utilization === "number" && Number.isFinite(utilization)) {
    return clampPercent(utilization * 100);
  }
  return null;
}

/**
 * Clamped rather than passed through, because the meter is drawn as a bar.
 *
 * Rounded to whole percent for the same reason the panel's reset is coarse: a rate limit is not
 * measured finely enough for a decimal to mean anything, and the digit would change on every read.
 */
function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

/** Epoch milliseconds, from epoch seconds or an ISO string. Zero when the source names none. */
function resetsAt(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 1000);
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * When the reading was taken, falling back to zero.
 *
 * Zero renders as an age of "the epoch", which is a reading the panel calls stale -- the right
 * answer for a source that would not say when it was written.
 */
function stamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    // Absent, unreadable, or half-written while its owner rewrites it. The meter is one part of a
    // surface whose subject is something else, and taking that down over it would trade the
    // answer for the decoration. The mirror is written atomically for this reason; the CLI's
    // config is not ours to make atomic.
    return null;
  }
}
