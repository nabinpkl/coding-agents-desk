// Claude's rate-limit meters, read off the response headers as they cross the proxy.
//
// The live source, and the only one that is live. Anthropic publishes the account's windows on
// every API response as `anthropic-ratelimit-unified-*`, Claude Code parses them into memory, and
// nothing durable is written: its own on-disk copy (`cachedUsageUtilization`) is an occasional
// write-behind that was absent entirely on this machine for a whole day of sessions. What IS
// dependable is the traffic itself, and this repo already watches it -- proxy-agent's observer is
// how the live transcript mirror works, and `claudeNetworkSource.ts` is subscribed to it.
//
// So the meters come from the same subscription, at no extra cost: one more field read off a flow
// the mirror already receives. Measured 2026-09-15 against the running observer, under the
// mirror's own SSE filter, on a `/v1/messages` flow carrying 29 headers:
//
//   anthropic-ratelimit-unified-5h-utilization  0.21
//   anthropic-ratelimit-unified-5h-reset        1789528800
//   anthropic-ratelimit-unified-7d-utilization  0.51
//   anthropic-ratelimit-unified-7d-reset        1789920000
//   anthropic-ratelimit-unified-5h-status       allowed
//
// proxy-agent redacts `authorization`, `proxy-authorization`, `cookie`, `set-cookie` and
// `x-api-key` and nothing else, so these arrive with their values intact.
//
// Units, which are the same trap `claudeQuota.ts` documents and are settled the same way: the
// utilization is a FRACTION (the CLI clamps it to [0,1] and multiplies by 100 for its status
// line) and the reset is epoch SECONDS.
//
// This reads Claude's traffic through a proxy Claude Code itself supports. It does not read its
// credentials and does not write anything into its install; see AGENTS.md, "Claude's own files
// are read-only, and its credentials are off limits".

import { orderQuotas, type QuotaSample } from "@/usage/quotaSample";

/** The header infix per window, and what that window meters. */
const WINDOWS = [
  { key: "5h", minutes: 5 * 60, scope: null },
  { key: "7d", minutes: 7 * 24 * 60, scope: null },
  // Not observed on this account, and carried because the CLI names the same two windows in its
  // own map (`seven_day_opus`, `seven_day_sonnet`). A window the headers never mention produces
  // no row, so guessing wrong here costs nothing.
  { key: "7d-opus", minutes: 7 * 24 * 60, scope: "Opus" },
  { key: "7d-sonnet", minutes: 7 * 24 * 60, scope: "Sonnet" },
] as const;

const PREFIX = "anthropic-ratelimit-unified-";

/**
 * The newest reading this process has seen, or null before the first response crosses the proxy.
 *
 * Process-global for the same reason the observer subscription is: the meters are an account-wide
 * fact, not a per-session one, and every session's responses report the same windows.
 */
let latest: { atMs: number; samples: QuotaSample[] } | null = null;

/**
 * Folds one flow's response headers into the current reading.
 *
 * Newest wins whole. A flow carrying no rate-limit headers at all leaves the previous reading
 * standing rather than clearing it: most flows are not `/v1/messages`, and a meter that blanked
 * every time a heartbeat went past would spend most of its life empty.
 */
export function noteRateLimitHeaders(headers: unknown, atMs: number): void {
  const samples = parseRateLimitHeaders(headers, atMs);
  if (samples.length === 0) return;
  if (latest && latest.atMs > atMs) return;
  latest = { atMs, samples };
}

/** Every window the last response reported, shortest first. Empty before the first one. */
export function currentLiveQuotas(): QuotaSample[] {
  return latest?.samples ?? [];
}

/** Drops the reading. For tests, and for a sidecar that has lost its observer subscription. */
export function resetLiveQuotas(): void {
  latest = null;
}

/**
 * Reads the windows out of one flow's headers.
 *
 * A window needs its utilization; a missing reset is carried as zero rather than dropping the row,
 * because "how full" is the number being asked for and "when it clears" is the decoration.
 */
export function parseRateLimitHeaders(headers: unknown, atMs: number): QuotaSample[] {
  if (!Array.isArray(headers)) return [];

  const values = new Map<string, string>();
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const { name, value, redacted } = header as {
      name?: unknown;
      value?: unknown;
      redacted?: unknown;
    };
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (redacted === true) continue;
    const lower = name.toLowerCase();
    if (!lower.startsWith(PREFIX)) continue;
    values.set(lower.slice(PREFIX.length), value);
  }
  if (values.size === 0) return [];

  const samples: QuotaSample[] = [];
  for (const window of WINDOWS) {
    const utilization = number(values.get(`${window.key}-utilization`));
    if (utilization === null) continue;
    samples.push({
      atMs,
      // A fraction on the wire, and the one place a 100 belongs.
      usedPercent: Math.round(Math.max(0, Math.min(1, utilization)) * 100),
      windowMinutes: window.minutes,
      resetsAtMs: (number(values.get(`${window.key}-reset`)) ?? 0) * 1000,
      // The headers carry no plan name. Null rather than a guess, as everywhere else.
      planType: null,
      scope: window.scope,
    });
  }
  return orderQuotas(samples);
}

function number(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
