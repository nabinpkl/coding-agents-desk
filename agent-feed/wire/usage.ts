// Token usage per calendar day, per vendor.
//
// The feature exists to answer one question the vendors' own surfaces do not: how much did a day
// actually cost, and how much of that was cache. On real data the cached share of input runs
// between 93% and 98%, so a figure that folds the two together is dominated by cache reads and
// says almost nothing about the work done. Every consumer of these types therefore gets the two
// numbers separately and derives the third.

/**
 * A vendor whose local records the sidecar can read.
 *
 * Not every vendor here is implemented -- `installed` on the report is what says whether one
 * answered -- but the id set is named once, here, so the panel does not grow its own copy.
 */
export type UsageVendorId = "codex" | "claude";

/**
 * One bucket of usage, summed over whatever the bucket is (a day, a model, a week).
 *
 * `inputTokens` is EVERYTHING sent, cache included; `cachedInputTokens` is the subset of it that
 * was served from cache. Uncached input is the difference, and is deliberately not a field: two
 * of the three numbers are what the vendors publish, and a stored third is a number that can
 * disagree with its own inputs.
 *
 * The two vendors state this differently and normalizing here is the highest-risk step in the
 * feature, so it is written down rather than left to each adapter's judgement:
 *
 * - Codex `last_token_usage.input_tokens` ALREADY INCLUDES `cached_input_tokens`, so
 *   `inputTokens` is that field unchanged.
 * - Claude `message.usage.input_tokens` EXCLUDES both `cache_read_input_tokens` and
 *   `cache_creation_input_tokens`, so `inputTokens` is the three added together.
 *
 * Getting Codex backwards -- adding `cached` on top of `input` -- double counts the cached
 * portion and inflates a day by up to 98% while still looking like a plausible number.
 */
export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** The reasoning portion of `outputTokens`, or 0 where the vendor does not separate it. */
  reasoningTokens: number;
  requests: number;
}

export interface UsageModelTotals {
  model: string;
  totals: UsageTotals;
}

export interface UsageDay {
  /** `YYYY-MM-DD` in the SIDECAR's local timezone, which is the machine the work happened on. */
  date: string;
  totals: UsageTotals;
  /** Heaviest model first. Records made before the transcript names a model are `unknown`. */
  byModel: UsageModelTotals[];
}

/**
 * A vendor-published rate limit, when the vendor publishes one.
 *
 * A live meter rather than history: it is read from the newest record and describes right now.
 * Reported without interpretation -- the panel shows the number and the reset, and draws no
 * conclusion about whether a limit moved.
 */
export interface UsageQuota {
  /** Human label derived from the window, e.g. "Weekly limit". */
  label: string;
  usedPercent: number;
  windowMinutes: number;
  /** Epoch milliseconds. */
  resetsAt: number;
  planType: string | null;
}

export interface UsageCoverage {
  /** `YYYY-MM-DD` of the oldest and newest day with data, or null when there is none. */
  from: string | null;
  to: string | null;
  sessions: number;
  /** Session files that could not be read. Surfaced, never swallowed: a skipped file is a
   *  silently wrong total. */
  unreadable: number;
}

export interface VendorUsage {
  vendor: UsageVendorId;
  displayName: string;
  /** Whether the vendor's local record directory exists at all. */
  installed: boolean;
  /** Only days that have data, oldest first. The panel fills the empty days of its own grid. */
  days: UsageDay[];
  quota: UsageQuota | null;
  coverage: UsageCoverage;
  /** Epoch milliseconds this report was produced. */
  scannedAt: number;
}

export interface UsageReport {
  vendors: VendorUsage[];
}

/**
 * What `GET /api/usage` streams.
 *
 * Up to two `report` messages -- one from cache, immediately, so a warm open paints without a
 * wait, then one after the incremental sweep if anything moved -- followed always by `settled`.
 *
 * `settled` is not decoration. Without it a reader cannot tell "the sweep finished and changed
 * nothing" from "the sweep is still running", because both look like a stream that has gone
 * quiet, and a transport carrying SSE cannot distinguish a deliberate server close from a
 * dropped connection. The terminal message is what makes the end of finite work observable.
 */
export type UsageStreamMessage =
  | { type: "report"; report: UsageReport }
  | { type: "settled" }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };
