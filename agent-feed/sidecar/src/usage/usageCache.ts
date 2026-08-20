// What the sidecar remembers about files it has already summed.
//
// A full sweep of one real Codex history -- 949 files, 5.06 GB -- takes 7.0 seconds with a warm
// page cache and longer cold. That is too slow to pay on every modal open and far too slow to
// repay after every host relaunch, so the per-file result is kept.
//
// The cache is safe because of how Codex files behave: a rollout lives under
// `sessions/YYYY/MM/DD/` and stops changing when its session ends, so a warm sweep re-reads only
// the handful touched today. Size and mtime together decide; a file whose bytes moved is summed
// again and its previous contribution replaced wholesale, never added to.
//
// One JSON file rather than SQLite, on purpose. At 949 sessions it is about 150 KB and a full
// rewrite per sweep costs nothing, where a schema would be a migration surface for a cache that
// can always be thrown away and rebuilt. The trigger for changing that is stated rather than
// left to taste: when this file passes a few megabytes, or when a query wants a GROUP BY the
// panel cannot do itself, it should become a table.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QuotaSample } from "./codexUsage.ts";
import type { DayModelTotals } from "./usageTotals.ts";

export interface CachedSession {
  size: number;
  mtimeMs: number;
  days: DayModelTotals;
  quota: QuotaSample | null;
}

export interface UsageCache {
  version: number;
  /** The zone the day keys were bucketed in; see `localDayKey`. */
  timezone: string;
  /** Absolute session-file path -> what summing it produced. */
  sessions: Record<string, CachedSession>;
}

const CACHE_VERSION = 1;

function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

export function emptyCache(): UsageCache {
  return { version: CACHE_VERSION, timezone: currentTimezone(), sessions: {} };
}

/**
 * Loads the cache, or starts a fresh one.
 *
 * A version bump or a timezone change discards everything rather than mixing. Day keys are local
 * calendar days, so a machine that moved zones has a cache whose buckets no longer mean what the
 * new ones mean -- and half-rebucketed history is worse than a slow first sweep, because it is
 * wrong without looking wrong.
 */
export async function loadUsageCache(path: string): Promise<UsageCache> {
  let parsed: UsageCache;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as UsageCache;
  } catch {
    // Absent or unreadable. Either way the answer is the same and the sweep rebuilds it; a cache
    // is the one thing in this sidecar allowed to fail quietly.
    return emptyCache();
  }
  if (parsed?.version !== CACHE_VERSION) return emptyCache();
  if (parsed.timezone !== currentTimezone()) return emptyCache();
  if (!parsed.sessions || typeof parsed.sessions !== "object") return emptyCache();
  return parsed;
}

/**
 * Writes the cache atomically.
 *
 * Through a temp file and a rename because a sweep interrupted mid-write would otherwise leave
 * truncated JSON that the next load throws away, turning one crash into a permanent slow start.
 */
export async function saveUsageCache(path: string, cache: UsageCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(cache), "utf8");
  await rename(temporary, path);
}
