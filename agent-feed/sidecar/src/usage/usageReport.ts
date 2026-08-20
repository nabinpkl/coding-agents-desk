// One sweep of a vendor's local records, folded into the report the panel renders.
//
// The sweep is incremental against `usageCache`, coalesced so two readers cannot start two of
// them, and it keeps its last answer so a reader gets something to paint before it runs.

import { stat } from "node:fs/promises";
import type {
  UsageCoverage,
  UsageDay,
  UsageModelTotals,
  UsageQuota,
  UsageReport,
  UsageVendorId,
  VendorUsage,
} from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import {
  codexInstalled,
  findCodexSessionFiles,
  scanCodexSession,
  type QuotaSample,
} from "./codexUsage.ts";
import { loadUsageCache, saveUsageCache, type UsageCache } from "./usageCache.ts";
import {
  emptyTuple,
  mergeDayModelTotals,
  toTotals,
  type DayModelTotals,
  type UsageTuple,
} from "./usageTotals.ts";

/**
 * How many session files are summed at once.
 *
 * The work is dominated by reading bytes, so this is about keeping the disk busy without holding
 * many multi-hundred-megabyte streams open at the same time.
 */
const SCAN_CONCURRENCY = 8;

/**
 * Which vendors this machine has records for, for `/api/config`.
 *
 * Answers the panel's "should I offer this at all" without sweeping anything. Empty means the
 * Profile popup shows Usage as unavailable rather than opening onto an empty grid.
 */
export function detectUsageVendors(codexHome: string = config.codexHomeDirectory): UsageVendorId[] {
  return codexInstalled(codexHome) ? ["codex"] : [];
}

export interface UsageScanner {
  /** The last completed report, or null before the first sweep. Never blocks. */
  cached(): UsageReport | null;
  /** Sweeps incrementally. Concurrent callers share one sweep. */
  scan(): Promise<UsageReport>;
}

export interface UsageScannerOptions {
  codexHome?: string;
  cachePath?: string;
  now?: () => number;
}

export function createUsageScanner(options: UsageScannerOptions = {}): UsageScanner {
  const codexHome = options.codexHome ?? config.codexHomeDirectory;
  const cachePath = options.cachePath ?? config.usageCachePath;
  const now = options.now ?? Date.now;

  let cache: UsageCache | null = null;
  let last: UsageReport | null = null;
  let inFlight: Promise<UsageReport> | null = null;

  async function sweep(): Promise<UsageReport> {
    cache ??= await loadUsageCache(cachePath);
    const codex = await scanCodexVendor(codexHome, cache, now());
    // Nothing was re-read, so nothing can have changed: the PREVIOUS report object is returned,
    // identity and all. The route compares by identity to decide whether a second message is
    // worth sending, and this is what lets a reader whose files have not moved paint once
    // instead of twice. `scannedAt` therefore means "when this data was produced", not "when we
    // last looked", which is the honest reading of a stamp on unchanged numbers.
    if (!codex.cacheChanged && last) return last;
    if (codex.cacheChanged) await saveUsageCache(cachePath, cache);
    const report: UsageReport = { vendors: [codex.vendor] };
    last = report;
    return report;
  }

  return {
    cached: () => last,
    scan: () => {
      // Coalesced rather than queued: two panels opening at once want the same answer, and the
      // second sweep would read the same bytes to produce it.
      inFlight ??= sweep().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

async function scanCodexVendor(
  codexHome: string,
  cache: UsageCache,
  scannedAt: number,
): Promise<{ vendor: VendorUsage; cacheChanged: boolean }> {
  const installed = codexInstalled(codexHome);
  if (!installed) {
    return {
      vendor: {
        vendor: "codex",
        displayName: "Codex",
        installed: false,
        days: [],
        quota: null,
        coverage: { from: null, to: null, sessions: 0, unreadable: 0 },
        scannedAt,
      },
      cacheChanged: false,
    };
  }

  const files = await findCodexSessionFiles(codexHome);
  const present = new Set(files);
  let cacheChanged = false;
  let unreadable = 0;
  let newest: QuotaSample | null = null;
  const totals: DayModelTotals = {};

  // Entries whose file is gone stop contributing. Without this a deleted or archived-then-purged
  // session would keep inflating its days for as long as the cache file survived.
  for (const path of Object.keys(cache.sessions)) {
    if (present.has(path)) continue;
    delete cache.sessions[path];
    cacheChanged = true;
  }

  for (let start = 0; start < files.length; start += SCAN_CONCURRENCY) {
    const batch = files.slice(start, start + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (path) => {
      try {
        const metadata = await stat(path);
        const known = cache.sessions[path];
        if (known && known.size === metadata.size && known.mtimeMs === metadata.mtimeMs) {
          return { path, entry: known, fresh: false as const };
        }
        const scanned = await scanCodexSession(path);
        return {
          path,
          entry: {
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            days: scanned.days,
            quota: scanned.quota,
          },
          fresh: true as const,
        };
      } catch {
        // Counted and surfaced on the report rather than swallowed: a file skipped in silence is
        // a total that is wrong without saying so.
        return { path, entry: null, fresh: false as const };
      }
    }));

    for (const result of results) {
      if (!result.entry) {
        unreadable += 1;
        continue;
      }
      if (result.fresh) {
        cache.sessions[result.path] = result.entry;
        cacheChanged = true;
      }
      mergeDayModelTotals(totals, result.entry.days);
      const quota = result.entry.quota;
      if (quota && (!newest || quota.atMs > newest.atMs)) newest = quota;
    }
  }

  const days = buildDays(totals);
  return {
    vendor: {
      vendor: "codex",
      displayName: "Codex",
      installed: true,
      days,
      quota: newest ? describeQuota(newest) : null,
      coverage: buildCoverage(days, files.length, unreadable),
      scannedAt,
    },
    cacheChanged,
  };
}

function buildDays(totals: DayModelTotals): UsageDay[] {
  const days: UsageDay[] = [];
  for (const date of Object.keys(totals).sort()) {
    const byModel: UsageModelTotals[] = [];
    const dayTotal: UsageTuple = emptyTuple();
    for (const [model, tuple] of Object.entries(totals[date]!)) {
      byModel.push({ model, totals: toTotals(tuple) });
      for (let index = 0; index < dayTotal.length; index += 1) dayTotal[index]! += tuple[index]!;
    }
    // Heaviest first, by the same number the calendar colours by, so the detail list reads in
    // the order that explains the cell.
    byModel.sort((left, right) => right.totals.inputTokens - left.totals.inputTokens);
    days.push({ date, totals: toTotals(dayTotal), byModel });
  }
  return days;
}

function buildCoverage(days: UsageDay[], sessions: number, unreadable: number): UsageCoverage {
  return {
    from: days[0]?.date ?? null,
    to: days[days.length - 1]?.date ?? null,
    sessions,
    unreadable,
  };
}

/**
 * Names the window a rate limit covers.
 *
 * Reported, not interpreted. Codex publishes a percentage and a window; the panel shows both and
 * says nothing about whether either has moved.
 */
function describeQuota(sample: QuotaSample): UsageQuota {
  return {
    label: quotaLabel(sample.windowMinutes),
    usedPercent: sample.usedPercent,
    windowMinutes: sample.windowMinutes,
    resetsAt: sample.resetsAtMs,
    planType: sample.planType,
  };
}

function quotaLabel(windowMinutes: number): string {
  if (windowMinutes <= 0) return "Rate limit";
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 7 ? "Weekly limit" : days === 1 ? "Daily limit" : `${days}-day limit`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`;
  return `${windowMinutes}-minute limit`;
}
