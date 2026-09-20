// One sweep of every vendor's local records, folded into the report the panel renders.
//
// The sweep is incremental against `usageCache`, coalesced so two readers cannot start two of
// them, and it keeps its last answer so a reader gets something to paint before it runs.
//
// The two vendors are scanned by separate functions rather than one parameterised over a vendor
// seam, because what they share is the shape of the OUTPUT and almost nothing about the work. A
// Codex rollout is a private ledger, so its files are summed and the sums added. A Claude
// transcript is not: the same request appears in several files, so its rows are merged under a
// global identity set and only then summed (`claudeUsage.ts` carries the measurements). A seam
// wide enough to hold both would be the two functions with an interface stretched over them.

import { stat } from "node:fs/promises";
import { config } from "@/config";
import type {
  QuotaReport,
  UsageCoverage,
  UsageDay,
  UsageModelTotals,
  UsageQuota,
  UsageReport,
  UsageVendorId,
  VendorUsage,
} from "@agentdesk/agent-feed-wire";
import type {
  CachedDaysSession,
  CachedRowsSession,
  CachedSession,
  UsageCache,
} from "@/usage/usageCache";
import {
  claudeInstalled,
  findClaudeSessionFiles,
  scanClaudeSession,
  type ClaudeUsageRow,
} from "@/usage/claudeUsage";
import { claudeModelAlias } from "@/usage/claudeModels";
import { readClaudeQuotas } from "@/usage/claudeQuota";
import {
  codexInstalled,
  findCodexSessionFiles,
  scanCodexSession,
} from "@/usage/codexUsage";
import { describeQuota, type QuotaSample } from "@/usage/quotaSample";
import { loadUsageCache, saveUsageCache } from "@/usage/usageCache";
import {
  addInto,
  emptyTuple,
  mergeDayModelTotals,
  toTotals,
  type DayModelTotals,
  type UsageTuple,
} from "@/usage/usageTotals";

/**
 * How many session files are summed at once.
 *
 * The work is dominated by reading bytes, so this is about keeping the disk busy without holding
 * many multi-hundred-megabyte streams open at the same time.
 */
const SCAN_CONCURRENCY = 8;

export interface UsageVendorPaths {
  codexHome: string;
  claudeProjects: string;
  claudeConfig: string;
  /** Where the statusline leaves Claude's live rate limits; see `config.claudeLimitsMirrorPath`. */
  claudeLimitsMirror: string;
}

/**
 * Which vendors this machine has records for, for `/api/config`.
 *
 * Answers the panel's "should I offer this at all" without sweeping anything. Empty means the
 * Profile popup shows Usage as unavailable rather than opening onto an empty grid.
 *
 * Ordered as `UsageVendorId` declares, not by what is installed, so the modal's tabs do not
 * reorder themselves on a machine where one vendor is later removed.
 */
export function detectUsageVendors(paths: Partial<UsageVendorPaths> = {}): UsageVendorId[] {
  const resolved = resolvePaths(paths);
  const vendors: UsageVendorId[] = [];
  if (codexInstalled(resolved.codexHome)) vendors.push("codex");
  if (claudeInstalled(resolved.claudeProjects)) vendors.push("claude");
  return vendors;
}

export interface UsageScanner {
  /** The last completed report, or null before the first sweep. Never blocks. */
  cached(): UsageReport | null;
  /** Sweeps incrementally. Concurrent callers share one sweep. */
  scan(): Promise<UsageReport>;
}

export interface UsageScannerOptions extends Partial<UsageVendorPaths> {
  cachePath?: string;
  now?: () => number;
}

export function createUsageScanner(options: UsageScannerOptions = {}): UsageScanner {
  const paths = resolvePaths(options);
  const cachePath = options.cachePath ?? config.usageCachePath;
  const now = options.now ?? Date.now;

  let cache: UsageCache | null = null;
  let last: UsageReport | null = null;
  let inFlight: Promise<UsageReport> | null = null;

  async function sweep(): Promise<UsageReport> {
    cache ??= await loadUsageCache(cachePath);
    const scannedAt = now();
    const codex = await scanCodexVendor(paths.codexHome, cache, scannedAt);
    const claude = await scanClaudeVendor(paths, cache, scannedAt);
    const cacheChanged = codex.cacheChanged || claude.cacheChanged;
    // Nothing was re-read, so nothing can have changed: the PREVIOUS report object is returned,
    // identity and all. The route compares by identity to decide whether a second message is
    // worth sending, and this is what lets a reader whose files have not moved paint once
    // instead of twice. `scannedAt` therefore means "when this data was produced", not "when we
    // last looked", which is the honest reading of a stamp on unchanged numbers.
    //
    // The quota is deliberately outside that test. It is a live meter read from a file the sweep
    // does not otherwise touch, so a report withheld because no transcript moved would pin a
    // reader to a limit reading from whenever they last opened a session.
    if (!cacheChanged && last && !quotaMoved(last, codex.vendor, claude.vendor)) return last;
    if (cacheChanged) await saveUsageCache(cachePath, cache);
    const report: UsageReport = { vendors: [codex.vendor, claude.vendor] };
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

function quotaMoved(previous: UsageReport, ...vendors: VendorUsage[]): boolean {
  return vendors.some((vendor) => {
    const before = previous.vendors.find((entry) => entry.vendor === vendor.vendor)?.quotas ?? [];
    return JSON.stringify(before) !== JSON.stringify(vendor.quotas);
  });
}

async function scanCodexVendor(
  codexHome: string,
  cache: UsageCache,
  scannedAt: number,
): Promise<{ vendor: VendorUsage; cacheChanged: boolean }> {
  if (!codexInstalled(codexHome)) {
    return { vendor: uninstalled("codex", "Codex", scannedAt), cacheChanged: false };
  }

  const files = await findCodexSessionFiles(codexHome);
  const swept = await sweepFiles(codexHome, files, cache, async (path) => {
    const scanned = await scanCodexSession(path);
    return { kind: "days" as const, days: scanned.days, quota: scanned.quota };
  });

  let newest: QuotaSample | null = null;
  const totals: DayModelTotals = {};
  for (const entry of swept.entries) {
    if (entry.kind !== "days") continue;
    mergeDayModelTotals(totals, entry.days);
    if (entry.quota && (!newest || entry.quota.atMs > newest.atMs)) newest = entry.quota;
  }

  const days = buildDays(totals, () => null);
  return {
    vendor: {
      vendor: "codex",
      displayName: "Codex",
      installed: true,
      days,
      // A list of one, because Codex publishes one window: its `rate_limits.primary`. The shape
      // is the vendors' common denominator rather than Claude's, since a vendor that later
      // publishes a second window should not need the wire changed to say so.
      quotas: newest ? [describeQuota(newest)] : [],
      coverage: buildCoverage(days, files.length, swept.unreadable),
      scannedAt,
    },
    cacheChanged: swept.cacheChanged,
  };
}

async function scanClaudeVendor(
  paths: UsageVendorPaths,
  cache: UsageCache,
  scannedAt: number,
): Promise<{ vendor: VendorUsage; cacheChanged: boolean }> {
  if (!claudeInstalled(paths.claudeProjects)) {
    return { vendor: uninstalled("claude", "Claude", scannedAt), cacheChanged: false };
  }

  const files = await findClaudeSessionFiles(paths.claudeProjects);
  const swept = await sweepFiles(paths.claudeProjects, files, cache, async (path) => ({
    kind: "rows" as const,
    rows: await scanClaudeSession(path),
  }));

  // The global dedup, and the reason Claude's cache holds rows at all. Files are visited in the
  // sorted order `findClaudeSessionFiles` returns, so which copy of a shared request wins is
  // decided the same way on every sweep -- and the copies agree anyway: of 105,452 distinct
  // requests on this machine, 58 differ in their token figures and 5 in their calendar day.
  const seen = new Set<string>();
  const totals: DayModelTotals = {};
  for (const entry of swept.entries) {
    if (entry.kind !== "rows") continue;
    for (const row of entry.rows) {
      if (seen.has(row[0])) continue;
      seen.add(row[0]);
      addRow(totals, row);
    }
  }

  const days = buildDays(totals, claudeModelAlias);
  return {
    vendor: {
      vendor: "claude",
      displayName: "Claude",
      installed: true,
      days,
      quotas: await claudeQuotas(paths),
      coverage: buildCoverage(days, files.length, swept.unreadable),
      scannedAt,
    },
    cacheChanged: swept.cacheChanged,
  };
}

async function claudeQuotas(paths: UsageVendorPaths): Promise<UsageQuota[]> {
  const samples = await readClaudeQuotas(paths.claudeConfig, paths.claudeLimitsMirror);
  return samples.map(describeQuota);
}

/**
 * Every vendor's live meters, without sweeping anything.
 *
 * What `/api/limits` answers, and the reason it can answer in milliseconds where the report it
 * mirrors takes seconds on a cold cache. Claude's meters are re-read from their two small files
 * on every call, because they are live and cheap. Codex's ride on the last completed sweep --
 * they are stamped onto rollout records, so producing a fresh one means reading the rollouts
 * again, and a popover is not worth gigabytes. A machine that has not swept yet therefore reports
 * no Codex meter rather than a stale one.
 */
export async function readVendorQuotas(
  options: Partial<UsageVendorPaths> = {},
  swept: UsageReport | null = null,
): Promise<QuotaReport> {
  const paths = resolvePaths(options);
  const codex = swept?.vendors.find((vendor) => vendor.vendor === "codex");
  return {
    vendors: [
      { vendor: "codex", displayName: "Codex", quotas: codex?.quotas ?? [] },
      { vendor: "claude", displayName: "Claude", quotas: await claudeQuotas(paths) },
    ],
  };
}

function addRow(totals: DayModelTotals, row: ClaudeUsageRow): void {
  const byModel = (totals[row[1]] ??= {});
  addInto((byModel[row[2]] ??= emptyTuple()), [row[3], row[4], row[5], row[6], 1]);
}

/**
 * Reads every file whose bytes have moved, reusing the cache for the rest.
 *
 * Shared by both vendors because this half genuinely is the same work: stat, compare, scan the
 * few that changed, and forget the entries whose file is gone. What differs is only what a scan
 * produces, which is why the caller passes that in and reads the entries back.
 */
async function sweepFiles(
  root: string,
  files: string[],
  cache: UsageCache,
  scan: (path: string) => Promise<ScannedBody>,
): Promise<{ entries: CachedSession[]; unreadable: number; cacheChanged: boolean }> {
  const present = new Set(files);
  const entries: CachedSession[] = [];
  let cacheChanged = false;
  let unreadable = 0;

  // Entries whose file is gone stop contributing. Without this a deleted or archived-then-purged
  // session would keep inflating its days for as long as the cache file survived.
  //
  // Scoped to paths under this vendor's own root, because the two vendors share one `sessions`
  // map: an unscoped eviction would let the Codex sweep delete every Claude entry as "gone", and
  // the Claude sweep behind it would then re-read 2.6 GB to put them back.
  for (const path of Object.keys(cache.sessions)) {
    if (present.has(path) || !path.startsWith(root)) continue;
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
        const scanned = await scan(path);
        return { path, entry: stamp(scanned, metadata.size, metadata.mtimeMs), fresh: true as const };
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
      entries.push(result.entry);
    }
  }

  return { entries, unreadable, cacheChanged };
}

/** What a scan produces, before the sweep stamps the file's size and mtime onto it. */
type ScannedBody =
  | Omit<CachedDaysSession, "size" | "mtimeMs">
  | Omit<CachedRowsSession, "size" | "mtimeMs">;

/** Written out per arm rather than spread, so the entry stays a discriminated union. */
function stamp(body: ScannedBody, size: number, mtimeMs: number): CachedSession {
  return body.kind === "days"
    ? { kind: "days", size, mtimeMs, days: body.days, quota: body.quota }
    : { kind: "rows", size, mtimeMs, rows: body.rows };
}

function uninstalled(vendor: UsageVendorId, displayName: string, scannedAt: number): VendorUsage {
  return {
    vendor,
    displayName,
    installed: false,
    days: [],
    quotas: [],
    coverage: { from: null, to: null, sessions: 0, unreadable: 0 },
    scannedAt,
  };
}

function buildDays(totals: DayModelTotals, alias: (model: string) => string | null): UsageDay[] {
  const days: UsageDay[] = [];
  for (const date of Object.keys(totals).sort()) {
    const byModel: UsageModelTotals[] = [];
    const dayTotal: UsageTuple = emptyTuple();
    for (const [model, tuple] of Object.entries(totals[date]!)) {
      byModel.push({ model, alias: alias(model), totals: toTotals(tuple) });
      addInto(dayTotal, tuple);
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

function resolvePaths(options: Partial<UsageVendorPaths>): UsageVendorPaths {
  return {
    codexHome: options.codexHome ?? config.codexHomeDirectory,
    claudeProjects: options.claudeProjects ?? config.claudeProjectsDirectory,
    claudeConfig: options.claudeConfig ?? config.claudeConfigPath,
    claudeLimitsMirror: options.claudeLimitsMirror ?? config.claudeLimitsMirrorPath,
  };
}
