"use client";

import { useEffect, useMemo } from "react";
import type { EventsPage } from "@/features/activity-feed/data-source/AgentDataSource";
import { newestGap } from "@/features/activity-feed/data-source/eventPaging";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

/**
 * Fetches the rows between what a thread holds and a reconnect's window, a page at a time.
 *
 * Keeping the rows held below a reconnect's window is only whole while the stall was shorter than
 * a window. Longer, and the snapshot starts past the newest row held, so the rows written during
 * the stall are in neither -- and nothing else would ever ask for them: paging reaches only below
 * the OLDEST row held, and the hole is above it. A reader at the live end saw the last message from
 * before the stall sitting straight on top of the current one.
 *
 * Re-armed per snapshot as well as per hole, because a page that a newer snapshot overtook is
 * thrown away, and the hole it was for is usually still the same hole.
 *
 * `fetchPage` and `onPage` must be stable across renders. Each is a dependency of the effect that
 * fetches, so a fresh function per render would cancel the page just asked for and ask again.
 */
export function useTimelineGapFill({
  events,
  fetchPage,
  epochRef,
  snapshotCount,
  onPage,
}: {
  /** Every row held, oldest first. */
  events: readonly ActivityEvent[];
  fetchPage: (offset: number, limit: number) => Promise<EventsPage>;
  /** Moved by every snapshot; a page fetched under an older value is about a window that is gone. */
  epochRef: { readonly current: number };
  snapshotCount: number;
  onPage: (events: readonly ActivityEvent[]) => void;
}): void {
  const gap = useMemo(() => newestGap(events.map((event) => event.index)), [events]);
  const gapOffset = gap?.offset ?? -1;
  const gapLimit = gap?.limit ?? 0;
  useEffect(() => {
    if (gapLimit <= 0) return;
    const requestEpoch = epochRef.current;
    let superseded = false;
    fetchPage(gapOffset, gapLimit).then(
      (page) => {
        if (superseded || requestEpoch !== epochRef.current) return;
        onPage(page.events);
      },
      (error: unknown) => {
        if (superseded) return;
        // Not the thread's `error`: that replaces an empty transcript, and this one has rows on
        // both sides of the hole. The next snapshot tries again.
        console.warn(
          `[timeline] could not fetch rows ${gapOffset}..${gapOffset + gapLimit - 1}: ` +
            String((error as Error)?.message ?? error),
        );
      },
    );
    return () => {
      superseded = true;
    };
  }, [fetchPage, onPage, epochRef, gapOffset, gapLimit, snapshotCount]);
}

/** The rows held with a page merged in, keeping whichever copy of a row has the newer revision. */
export function withNewer(
  held: Map<number, ActivityEvent>,
  page: readonly ActivityEvent[],
): Map<number, ActivityEvent> {
  const events = new Map(held);
  for (const event of page) {
    const existing = events.get(event.index);
    if (!existing || (existing.revision ?? 0) < (event.revision ?? 0)) events.set(event.index, event);
  }
  return events;
}
