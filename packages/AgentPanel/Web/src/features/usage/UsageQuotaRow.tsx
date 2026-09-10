"use client";

import type { UsageQuota } from "@agentdesk/agent-feed-wire";
import { formatAge, formatResetIn, STALE_QUOTA_MS } from "@/features/usage/formatTokens";

/**
 * One row tall whether or not the vendor publishes a limit, so its absence moves nothing.
 *
 * The reset and the reading's age share one slot rather than taking two. A fresh sample answers
 * "when does this clear"; a stale one cannot, because its reset has usually already passed -- so
 * it answers "how old is this" instead, which is the only true thing left to say about it. Both
 * are always on the element's title for a reader who wants the other.
 */
export function QuotaRow({ quota, now }: { quota: UsageQuota | null; now: () => number }) {
  // Two lines at phone width, one from `sm` up, both fixed: the row's contents do not change while
  // a day is hovered, but a height that depended on how they wrapped would still move the grid on
  // the first render after a report landed.
  if (!quota) return <div className="h-8 sm:h-4" aria-hidden />;
  return (
    <div className="flex h-8 flex-wrap items-center gap-x-3 overflow-hidden text-xs text-muted-foreground sm:h-4">
      <span className="shrink-0 text-foreground">{quota.label}</span>
      <span className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full bg-foreground/60"
          style={{ width: `${Math.min(100, Math.max(0, quota.usedPercent))}%` }}
        />
      </span>
      <span className="shrink-0 font-mono">{quota.usedPercent}%</span>
      <QuotaFreshness quota={quota} now={now} />
      {quota.planType ? <span className="truncate">plan {quota.planType}</span> : null}
    </div>
  );
}

function QuotaFreshness({ quota, now }: { quota: UsageQuota; now: () => number }) {
  const at = now();
  const stale = at - quota.sampledAt > STALE_QUOTA_MS;
  return (
    <span
      className={`shrink-0 ${stale ? "text-foreground/70" : ""}`}
      title={`read ${formatAge(quota.sampledAt, at)}, resets in ${formatResetIn(quota.resetsAt, at)}`}
    >
      {stale ? `reading ${formatAge(quota.sampledAt, at)}` : `resets in ${formatResetIn(quota.resetsAt, at)}`}
    </span>
  );
}
