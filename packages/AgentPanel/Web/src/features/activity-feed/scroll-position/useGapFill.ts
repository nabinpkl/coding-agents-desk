"use client";

// Loading the rows a gap stands for, as the reader reaches it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Gap } from "@/features/activity-feed/data-source/eventPaging";
import type { FeedItem, GapItem } from "@/features/activity-feed/rows/activityDisplayItems";

/**
 * A gap by both its edges, unlike its row key: every page that lands moves one edge, so the gap
 * left behind is a different one and is asked for afresh even before this one's request settles.
 */
export function gapIdentity(gap: Gap): string {
  return `${gap.above}-${gap.below}`;
}

/**
 * Fills each gap row that comes within the virtualizer's rendered range, a page at a time, from
 * the side the reader is approaching it from (ADR-0125).
 *
 * A gap at or above the top of the viewport is being scrolled up to, so its page is the one that
 * ends at the row under it; one below the top is being scrolled down to, so its page follows the
 * row over it. Either way the row at the top of the viewport is a transcript row on the reader's
 * side of the gap, which is what the virtualizer's end anchor holds still while the page lands.
 * Nothing loads for a gap the reader is not near: a range opened around a jump leaves the rows
 * between it and the live end unread until somebody scrolls to them.
 *
 * A page that fails marks its gap, which then offers a retry rather than asking again on every
 * scroll; so does a page that was kept and left the gap where it was, which a sidecar answering
 * correctly never does, and which would otherwise be asked for again on every render. `failedGaps`
 * holds `gapIdentity`s.
 */
export function useGapFill({
  fillGap,
  rowItems,
  topRowIndex,
  virtualItems,
}: {
  /** Resolves to whether the page was kept; one a snapshot overtook is not. */
  fillGap: (gap: Gap, from: "below" | "above") => Promise<boolean>;
  rowItems: readonly (FeedItem | { kind: "tail" })[];
  /** The row at the top of the viewport, as an index into `rowItems`. */
  topRowIndex: number | null;
  virtualItems: readonly { index: number }[];
}): { failedGaps: ReadonlySet<string>; retryGap: (gap: GapItem) => void } {
  const pendingRef = useRef(new Set<string>());
  // Gaps a kept page was read into. Every kept page moves an edge, so seeing one again is a page
  // that reached none of the rows it was for.
  const filledRef = useRef(new Set<string>());
  const [failedGaps, setFailedGaps] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    for (const { index } of virtualItems) {
      const item = rowItems[index];
      if (item?.kind !== "gap") continue;
      const key = gapIdentity(item);
      if (pendingRef.current.has(key) || failedGaps.has(key)) continue;
      if (filledRef.current.has(key)) {
        console.error(`[timeline] a page into the rows between ${item.above} and ${item.below} did not reach them`);
        setFailedGaps((current) => new Set(current).add(key));
        continue;
      }
      pendingRef.current.add(key);
      const from = index <= (topRowIndex ?? 0) ? "below" : "above";
      fillGap({ above: item.above, below: item.below }, from).then(
        // A kept page moved an edge, so what is left is a new gap and this runs again for it. One a
        // snapshot overtook changed nothing and is simply asked for again.
        (kept) => {
          pendingRef.current.delete(key);
          if (kept) filledRef.current.add(key);
        },
        (error: unknown) => {
          pendingRef.current.delete(key);
          console.error(`[timeline] could not load the rows between ${item.above} and ${item.below}`, error);
          setFailedGaps((current) => new Set(current).add(key));
        },
      );
    }
  }, [virtualItems, rowItems, topRowIndex, fillGap, failedGaps]);

  const retryGap = useCallback((gap: GapItem) => {
    filledRef.current.delete(gapIdentity(gap));
    setFailedGaps((current) => {
      const next = new Set(current);
      next.delete(gapIdentity(gap));
      return next;
    });
  }, []);

  return { failedGaps, retryGap };
}
