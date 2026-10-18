// A rate-limit reading, and the naming of the window it covers.
//
// Shared rather than owned by either adapter, because the two vendors read theirs from very
// different places -- Codex from the newest rollout record it has just summed, Claude from files
// written by a process the sidecar never talks to -- and both then answer the same question in
// the panel.

import type { UsageQuota } from "@agentdesk/agent-feed-wire";

/** A rate-limit reading, stamped so the newest across all sources wins. */
export interface QuotaSample {
  atMs: number;
  usedPercent: number;
  windowMinutes: number;
  resetsAtMs: number;
  planType: string | null;
  /**
   * What this window meters, where a vendor meters more than one thing over the same window --
   * Claude publishes an account-wide `seven_day` and a `seven_day_opus` beside it. Null for a
   * window that covers everything, which is every window Codex publishes.
   *
   * It exists so the label can say which is which. Two rows both reading "Weekly limit" at
   * different percentages is a surface that looks broken.
   */
  scope?: string | null;
}

/**
 * Names the window a rate limit covers.
 *
 * Reported, not interpreted. The vendor publishes a percentage and a window; the panel shows both
 * and says nothing about whether either has moved.
 */
export function describeQuota(sample: QuotaSample): UsageQuota {
  return {
    label: quotaLabel(sample.windowMinutes, sample.scope ?? null),
    usedPercent: sample.usedPercent,
    windowMinutes: sample.windowMinutes,
    resetsAt: sample.resetsAtMs,
    scope: sample.scope ?? null,
    planType: sample.planType,
    sampledAt: sample.atMs,
  };
}

export function quotaLabel(windowMinutes: number, scope: string | null = null): string {
  const window = windowName(windowMinutes);
  return scope ? `${window} (${scope})` : window;
}

function windowName(windowMinutes: number): string {
  if (windowMinutes <= 0) return "Rate limit";
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 7 ? "Weekly limit" : days === 1 ? "Daily limit" : `${days}-day limit`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`;
  return `${windowMinutes}-minute limit`;
}

/**
 * Shortest window first, and within one window the account-wide meter before the ones scoped to a
 * model.
 *
 * Fixed rather than sorted by how full each is: the rows are read in the same place every time a
 * reader opens the popover, and an order that tracked the numbers would move them around under
 * exactly the reader who is watching one climb.
 */
export function orderQuotas(samples: QuotaSample[]): QuotaSample[] {
  return [...samples].sort(
    (left, right) => left.windowMinutes - right.windowMinutes || (left.scope ?? "").localeCompare(right.scope ?? ""),
  );
}
