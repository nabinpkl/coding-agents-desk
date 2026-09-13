"use client";

// Which bars to pin over the transcript, and which transcript line is at the top.
//
// The rules themselves are in `activityStickyHeaders.ts`, deliberately without React so
// they can be tested with no virtualiser. This is the part that reads the live geometry
// and hands the answers to the feed: all three read the same measurement cache, and
// separating one from the others is how they drift.

import { useMemo } from "react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { leadEvent, type DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import {
  selectStickyCurrentIndex,
  selectStickyUserIndex,
} from "@/features/activity-feed/sticky-headers/activityStickyHeaders";

/** Fallback for the sticky bar's height before it has rendered once. */
const STICKY_HEIGHT_ESTIMATE = 44;

export function useStickyIndices({
  items,
  mode,
  rowItems,
  rowVirtualizer,
  scrollTop,
  stickyHeaderRef,
  unloadedUserBar,
  virtualItems,
}: {
  items: DisplayItem[];
  mode: EventMode;
  /** The rows on screen, including the live tail the durable list does not know about. */
  rowItems: readonly (DisplayItem | { kind: "tail" })[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollTop: number;
  stickyHeaderRef: RefObject<HTMLButtonElement | null>;
  /** The user bar is up for a message the feed has not loaded, so the current bar sits below it. */
  unloadedUserBar: boolean;
  virtualItems: { index: number; end: number }[];
}) {
  // Most recent USER event whose own heading has scrolled out of view.
  // `measurementsCache` is the public mirror of the private getMeasurements();
  // the getVirtualItems() call above refreshes it every render, so it holds
  // current geometry for every row, including those scrolled off. `virtualItems`
  // stays a dependency so a re-measure is picked up even without a scroll.
  const stickyUserIndex = useMemo<number | null>(() => {
    if (items.length === 0) return null;
    return selectStickyUserIndex(
      items,
      rowVirtualizer.measurementsCache,
      scrollTop,
      stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, virtualItems, items]);
  // Only ever a user row, which is always a single event, but resolved through the
  // shared accessor so this does not have to be revisited if another multi-event row
  // kind appears.
  const stickyUserItem = stickyUserIndex === null ? null : items[stickyUserIndex];
  const stickyUser: ActivityEvent | null = stickyUserItem
    ? leadEvent(stickyUserItem)
    : null;

  // Event row currently straddling the top of the viewport: its heading has
  // scrolled past, but its content is still on screen. Drives the secondary
  // sticky which lets the viewer jump back to that row's start.
  const stickyCurrentIndex = useMemo<number | null>(() => {
    if (items.length === 0) return null;
    return selectStickyCurrentIndex(
      items,
      rowVirtualizer.measurementsCache,
      scrollTop,
      stickyUser || unloadedUserBar ? (stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE) : 0,
      stickyUserIndex,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, virtualItems, items, stickyUser, stickyUserIndex, unloadedUserBar]);
  const stickyCurrent: DisplayItem | null =
    stickyCurrentIndex === null ? null : items[stickyCurrentIndex] ?? null;

  // The transcript line at the top of the viewport: the first row still on screen.
  //
  // This is what gets remembered, and it is deliberately a transcript event rather than the
  // offset it sits at. An offset means nothing on the next visit -- rows carry estimated heights
  // until they are measured, the feed opens on a window of the newest events rather than the whole
  // thread, and a live session has grown in the meantime -- where the event is the one thing every
  // one of those preserves.
  const topEvent = useMemo<number | null>(() => {
    for (const row of virtualItems) {
      if (row.end <= scrollTop) continue;
      const item = rowItems[row.index];
      // The live tail counts rows in the sidecar's projection rather than lines in the transcript,
      // so it is not an anchor -- and a reader sitting on it is at the end, which needs none.
      return !item || item.kind === "tail" ? null : leadEvent(item).index;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, virtualItems, rowItems]);

  return { stickyCurrent, stickyCurrentIndex, stickyUser, stickyUserIndex, topEvent };
}
