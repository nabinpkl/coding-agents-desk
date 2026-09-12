"use client";

import type { UsageTotals } from "@agentdesk/agent-feed-wire";
import { formatCount, formatPercent, formatTokens } from "./formatTokens";
import { cachedShare, uncachedInput } from "./usageGrid";

/**
 * The numbers a bucket is made of.
 *
 * Input, cached, and uncached together, because the split is the whole point: on real data the
 * cached share runs from 88% to 99%, so a single input figure is mostly a picture of cache reads.
 *
 * A fixed-column grid rather than a wrapping row. These figures change width with their digits --
 * "4.00M" against "485.22M" -- and a wrapping row re-flowed from one line to two as the pointer
 * moved between days, which is the same layout shift arriving by a different route.
 */
export function TotalsRow({
  label,
  totals,
  withheld = false,
}: {
  label: string;
  totals: UsageTotals;
  withheld?: boolean;
}) {
  const show = (value: string) => (withheld ? "—" : value);
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
      <Figure name="input" value={show(formatTokens(totals.inputTokens))} />
      {/* The share rides the LABEL, not the value. As part of the value the cached figure was half
          again as wide as any other and was the one that truncated at phone width, which is the
          worst possible figure to cut: it is the one the calendar exists to show. */}
      <Figure
        name={withheld ? "cached" : `cached (${formatPercent(cachedShare(totals))})`}
        value={show(formatTokens(totals.cachedInputTokens))}
      />
      <Figure name="uncached" value={show(formatTokens(uncachedInput(totals)))} />
      <Figure name="output" value={show(formatTokens(totals.outputTokens))} />
      <Figure name="requests" value={show(formatCount(totals.requests))} />
    </dl>
  );
}

/**
 * One figure: a small muted label with its number under it.
 *
 * Stacked at every width, which is the only arrangement that fits. Side by side, a label and a
 * token count need about 135px and the widest layout here gives a column 129px, so the figure that
 * overflowed was `cached` -- the one this whole surface exists to show. Stacked, a column has to
 * fit only the longer of the two, and the row keeps a fixed line count so it cannot reflow as the
 * numbers change.
 */
function Figure({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="h-4 truncate text-muted-foreground">{name}</dt>
      <dd className="h-4 truncate font-mono text-foreground">{value}</dd>
    </div>
  );
}
