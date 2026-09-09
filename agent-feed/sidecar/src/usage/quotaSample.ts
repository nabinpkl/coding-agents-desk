// A rate-limit reading, and the naming of the window it covers.
//
// Shared rather than owned by either adapter, because the two vendors read theirs from very
// different places -- Codex from the newest rollout record it has just summed, Claude from a
// config cache written by a process the sidecar never talks to -- and both then answer the same
// one-row question in the panel.

import type { UsageQuota } from "@agentdesk/agent-feed-wire";

/** A rate-limit reading, stamped so the newest across all sources wins. */
export interface QuotaSample {
  atMs: number;
  usedPercent: number;
  windowMinutes: number;
  resetsAtMs: number;
  planType: string | null;
}

/**
 * Names the window a rate limit covers.
 *
 * Reported, not interpreted. The vendor publishes a percentage and a window; the panel shows both
 * and says nothing about whether either has moved.
 */
export function describeQuota(sample: QuotaSample): UsageQuota {
  return {
    label: quotaLabel(sample.windowMinutes),
    usedPercent: sample.usedPercent,
    windowMinutes: sample.windowMinutes,
    resetsAt: sample.resetsAtMs,
    planType: sample.planType,
    sampledAt: sample.atMs,
  };
}

export function quotaLabel(windowMinutes: number): string {
  if (windowMinutes <= 0) return "Rate limit";
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 7 ? "Weekly limit" : days === 1 ? "Daily limit" : `${days}-day limit`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`;
  return `${windowMinutes}-minute limit`;
}
