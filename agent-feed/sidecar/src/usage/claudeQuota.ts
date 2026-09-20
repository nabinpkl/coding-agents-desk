// Claude's rate-limit meters, read from whichever of two files on this machine is fresher.
//
// Codex stamps `rate_limits` onto the rollout records the sweep is already reading, so its meter
// falls out of the same pass. Claude writes nothing of the kind into a transcript: 288,219 usage
// records carry no limit field, and the only rate-limit trace there is `error: "rate_limit"` on a
// 429, which says a limit was HIT and nothing about where one stands.
//
// So there are two places to look, and both are caches somebody else owns:
//
//   1. `cachedUsageUtilization` in the CLI's own top-level config, holding the windows it last
//      saw: `{ fetchedAtMs, accountUuid, utilization: { five_hour: { utilization, resets_at },
//      seven_day: {...}, seven_day_opus: {...} } }`. The CLI only writes it when its copy has
//      gone stale, drops it on logout, and ignores it when the account it was written for is not
//      the current one -- so it is absent for long stretches. Measured 2026-09-15 on this
//      machine (CLI 2.1.273): absent from `~/.claude.json` entirely, and from all five rotated
//      backups, while sessions ran all day.
//
//   2. The statusline mirror (`tools/claude-statusline-mirror.sh`). The CLI hands its statusline
//      command `.rate_limits.<window>.used_percentage` on every render, taken from the last
//      response's headers rather than from a cache, and the mirror writes that payload down. It
//      is the only source that is live rather than occasional, and it exists only on a machine
//      whose statusline is configured to write it.
//
// Two unit traps, both settled by reading the CLI rather than by assuming, because both are
// silent when wrong:
//
//   - `utilization` is a FRACTION. The CLI's header parser clamps it with
//     `Math.max(0, Math.min(1, s))` and its near-limit hint compares it against 0.95, and the
//     statusline payload is built by multiplying it by 100. Read as a percent, a window at 92%
//     renders as 1%.
//   - `resets_at` is epoch SECONDS in both files (the CLI tests it as `resets_at * 1000 >
//     Date.now()`). An ISO string is accepted too, since neither file's shape is ours and an
//     older CLI wrote one.

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

/** One window as either file spells it. The two differ only in the name of the number. */
interface WindowReading {
  /** The config cache's spelling: a fraction between 0 and 1. */
  utilization?: number | null;
  /** The statusline mirror's spelling: already multiplied out, 0 to 100. */
  used_percentage?: number | null;
  /** Epoch seconds, or an ISO timestamp from an older CLI. */
  resets_at?: number | string | null;
}

interface ClaudeConfig {
  cachedUsageUtilization?: {
    fetchedAtMs?: number | null;
    utilization?: Record<string, WindowReading | null | undefined>;
  } | null;
}

interface LimitsMirror {
  fetchedAtMs?: number | null;
  rate_limits?: Record<string, WindowReading | null | undefined>;
}

/**
 * Every window Claude publishes a reading for, shortest window first.
 *
 * The two sources are read together and the NEWER one wins whole, rather than being merged
 * window by window. Merging would put two readings taken hours apart on one surface under one
 * age, and the age is the only thing that tells a reader whether to believe the number at all.
 *
 * An empty list is a real answer and stays empty. A zero would render as a meter with plenty
 * left, which is a claim; nothing renders as no meter, which is the truth.
 */
export async function readClaudeQuotas(
  configPath: string,
  mirrorPath: string,
): Promise<QuotaSample[]> {
  const [cached, mirrored] = await Promise.all([
    readConfigWindows(configPath),
    readMirrorWindows(mirrorPath),
  ]);
  const newest = [cached, mirrored]
    .filter((source) => source !== null && source.samples.length > 0)
    .sort((left, right) => right!.fetchedAtMs - left!.fetchedAtMs)[0];
  return newest ? orderQuotas(newest.samples) : [];
}

interface QuotaSource {
  fetchedAtMs: number;
  samples: QuotaSample[];
}

async function readConfigWindows(path: string): Promise<QuotaSource | null> {
  const parsed = await readJson<ClaudeConfig>(path);
  const cached = parsed?.cachedUsageUtilization;
  if (!cached?.utilization || typeof cached.utilization !== "object") return null;
  return collect(cached.utilization, stamp(cached.fetchedAtMs));
}

async function readMirrorWindows(path: string): Promise<QuotaSource | null> {
  const parsed = await readJson<LimitsMirror>(path);
  if (!parsed?.rate_limits || typeof parsed.rate_limits !== "object") return null;
  return collect(parsed.rate_limits, stamp(parsed.fetchedAtMs));
}

function collect(
  windows: Record<string, WindowReading | null | undefined>,
  fetchedAtMs: number,
): QuotaSource {
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
  return { fetchedAtMs, samples };
}

/** Whole percent, from whichever of the two spellings the source uses. */
function usedPercent(reading: WindowReading | null | undefined): number | null {
  if (!reading) return null;
  const percentage = reading.used_percentage;
  if (typeof percentage === "number" && Number.isFinite(percentage)) return clampPercent(percentage);
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
