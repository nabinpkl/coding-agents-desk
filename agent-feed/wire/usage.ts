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
  /**
   * The model id exactly as the vendor's record states it, minus the two spellings that are the
   * same model: a `[...]` variant suffix and a trailing release date. Those are stripped so one
   * model cannot become two rows; nothing else is folded, because `claude-fable-5` and
   * `claude-fable-5-1` are different models and a rule that merged them would be silently wrong.
   */
  model: string;
  /**
   * The short name a reader recognises (`opus 5`, `sonnet 5`), or null where the vendor's own id
   * already is one. Both are carried: the id is what the record says and what a later question
   * about pricing needs, the alias is what makes a list of five ids readable at a glance.
   */
  alias: string | null;
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
  /** Human label derived from the window and what it covers, e.g. "Weekly limit (Opus)". */
  label: string;
  usedPercent: number;
  windowMinutes: number;
  /** Epoch milliseconds. */
  resetsAt: number;
  /**
   * What this window meters, where a vendor meters more than one thing over the same window --
   * Claude publishes an account-wide `seven_day` and a `seven_day_opus` beside it. Null for a
   * window that covers everything, which is every window Codex publishes.
   *
   * Carried rather than left to the label, because two readers want different things from it: the
   * popover spells it into the label, and the compact readout in the composer shows the
   * account-wide windows ONLY, which it cannot select without being told which those are.
   */
  scope: string | null;
  planType: string | null;
  /**
   * Epoch milliseconds the vendor published this reading.
   *
   * Not decoration, and not the same as `VendorUsage.scannedAt`: the two vendors' meters age very
   * differently. Codex stamps its `rate_limits` on the newest rollout record, so the sample is as
   * fresh as the last request. Claude's lives in a config cache the CLI refreshes on its own
   * schedule -- measured 45 hours stale on this machine, with a `resetsAt` already in the past --
   * so a reader shown the number alone would read a two-day-old meter as current.
   */
  sampledAt: number;
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
  /**
   * Every window this vendor publishes a reading for, shortest window first, empty when it
   * publishes none.
   *
   * A list rather than the single most-used window it used to be, because the windows do not
   * substitute for one another: Claude meters five hours and seven days at once, and a reader
   * deciding whether to start something long needs the one that is about to stop them AND the one
   * that is not. Which of the two that is changes during a day, so picking one here would have
   * made the answer depend on when it was asked.
   */
  quotas: UsageQuota[];
  coverage: UsageCoverage;
  /** Epoch milliseconds this report was produced. */
  scannedAt: number;
}

export interface UsageReport {
  vendors: VendorUsage[];
}

/**
 * One vendor's live rate-limit meters, with no history beside them.
 *
 * The same `UsageQuota` values `VendorUsage` carries, split out so they can be asked for on their
 * own. Reading them costs one small file per vendor, where the report they ride on sweeps
 * gigabytes -- so a surface that wants only the meters (the context readout's detail popover) can
 * have them in milliseconds instead of opening the whole Usage sweep to get at one row.
 */
export interface VendorQuotas {
  vendor: UsageVendorId;
  displayName: string;
  quotas: UsageQuota[];
}

/** Every vendor's live meters, and nothing else. */
export interface QuotaReport {
  vendors: VendorQuotas[];
}

/**
 * What `GET /api/limits` streams: a report on open, and another whenever the meters move.
 *
 * A stream rather than a plain read because the sidecar already learns this by PUSH. Anthropic
 * publishes the account's windows on every API response, and the proxy observer hands those
 * headers over as each request comes back, so a reader that polled would be asking on a timer for
 * something already known -- and would be at its most stale in the seconds after a turn is sent,
 * which is exactly when somebody looks at it.
 *
 * Endless, unlike `UsageStreamMessage`: there is no finite piece of work to settle here, so the
 * stream ends when the reader goes away and never says it is done.
 */
export type LimitsStreamMessage =
  | { type: "report"; report: QuotaReport }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };

/**
 * What `GET /api/usage` streams.
 *
 * Up to two `report` messages -- one from cache, immediately, so a warm open paints without a
 * wait, then one after the incremental sweep if anything moved -- and then exactly one terminal
 * message: `settled` when the sweep finished, `error` when it could not.
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
