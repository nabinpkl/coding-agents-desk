// OpenCode Go plan meters: `GET <zen>/go/v1/usage` with the plan key as a bearer.
//
// Undocumented endpoint, so everything arriving is validated and anything unexpected is UNKNOWN,
// never zero. Observed body (2026-10-16):
//   {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-10-16T08:34:37.000Z"},
//             "weekly":{...},"monthly":{...}}}
// `rolling` is the five-hour window. Only `status: "ok"` has been seen, so the status string is
// passed through and nothing branches on it.
//
// The key never leaves this file's callers: it is not logged and no error text built here can
// contain it.

import type { UsageQuota, VendorQuotas } from "@agentdesk/agent-feed-wire";

/** The windows the endpoint names, shortest first, with the label and length the panel shows. */
const WINDOWS = [
  { key: "rolling", label: "Go 5-hour limit", minutes: 5 * 60 },
  { key: "weekly", label: "Go weekly limit", minutes: 7 * 24 * 60 },
  { key: "monthly", label: "Go monthly limit", minutes: 30 * 24 * 60 },
] as const;

const UNAVAILABLE_NAME = "OpenCode Go";

/**
 * The windows a body carries, or null when it carries none that validate.
 *
 * A window missing a field, or with a percent outside 0..100 or a reset that is not a date, is
 * dropped on its own: it is unknown, and the others are still true. Rounded to a whole percent,
 * which is what the other meters show.
 */
export function parseGoUsage(body: unknown, sampledAt: number): UsageQuota[] | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const quotas: UsageQuota[] = [];
  for (const window of WINDOWS) {
    const reading = (usage as Record<string, unknown>)[window.key] as
      | { status?: unknown; percent?: unknown; resetsAt?: unknown }
      | null
      | undefined;
    if (typeof reading !== "object" || reading === null) continue;
    const { status, percent, resetsAt } = reading;
    if (typeof status !== "string" || status.length === 0) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
    if (!Number.isFinite(reset)) continue;
    quotas.push({
      label: window.label,
      usedPercent: Math.round(percent),
      windowMinutes: window.minutes,
      resetsAt: reset,
      scope: null,
      planType: "go",
      sampledAt,
      status,
    });
  }
  return quotas.length > 0 ? quotas : null;
}

export interface GoFetchDeps {
  fetch: typeof fetch;
  url: URL;
  key: string;
  now: () => number;
}

/** One read of the endpoint, as the vendor entry the limits stream carries. */
export async function fetchGoQuotas(deps: GoFetchDeps): Promise<VendorQuotas> {
  const unavailable = (reason: string): VendorQuotas => ({
    vendor: "opencode-go",
    displayName: UNAVAILABLE_NAME,
    quotas: [],
    unavailable: reason,
  });
  try {
    const response = await deps.fetch(deps.url, {
      headers: { Authorization: `Bearer ${deps.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return unavailable(`HTTP ${response.status}`);
    const quotas = parseGoUsage(await response.json(), deps.now());
    return quotas
      ? { vendor: "opencode-go", displayName: UNAVAILABLE_NAME, quotas }
      : unavailable("unexpected response shape");
  } catch {
    // Deliberately no error text: a request failure's message can echo request details.
    return unavailable("request failed");
  }
}
