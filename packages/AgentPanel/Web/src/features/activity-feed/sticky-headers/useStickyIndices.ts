"use client";

// Which bars to pin over the transcript, and which transcript line is at the top.
//
// The rules themselves are in `activityStickyHeaders.ts`, deliberately without React so
// they can be tested with no virtualiser. This is the part that reads the live geometry
// and hands the answers to the feed: all three read the same measurement cache, and
// separating one from the others is how they drift.

import { useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { leadEvent, type DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import {
  selectStickyCurrentIndex,
  selectStickyUserIndex,
  type StickyMeasurement,
} from "@/features/activity-feed/sticky-headers/activityStickyHeaders";

/** Fallback for the sticky bar's height before it has rendered once. */
const STICKY_HEIGHT_ESTIMATE = 44;

interface StickyAnswer {
  stickyUserIndex: number | null;
  stickyCurrentIndex: number | null;
  /** The row at the top of the viewport, as an index into `rowItems`. */
  topRowIndex: number | null;
}

/** The three answers for one scroll offset, from one read of the measurement cache. */
function answerAt(
  items: DisplayItem[],
  measurements: readonly (StickyMeasurement & { end: number })[],
  rowCount: number,
  scrollTop: number,
  barHeight: number,
  unloadedUserBar: boolean,
): StickyAnswer {
  if (items.length === 0) return { stickyUserIndex: null, stickyCurrentIndex: null, topRowIndex: null };
  const stickyUserIndex = selectStickyUserIndex(items, measurements, scrollTop, barHeight);
  const stickyCurrentIndex = selectStickyCurrentIndex(
    items,
    measurements,
    scrollTop,
    stickyUserIndex !== null || unloadedUserBar ? barHeight : 0,
    stickyUserIndex,
  );
  let topRowIndex: number | null = null;
  const limit = Math.min(rowCount, measurements.length);
  for (let index = 0; index < limit; index++) {
    if (measurements[index]!.end > scrollTop) {
      topRowIndex = index;
      break;
    }
  }
  return { stickyUserIndex, stickyCurrentIndex, topRowIndex };
}

function sameAnswer(left: StickyAnswer, right: StickyAnswer): boolean {
  return left.stickyUserIndex === right.stickyUserIndex
    && left.stickyCurrentIndex === right.stickyCurrentIndex
    && left.topRowIndex === right.topRowIndex;
}

/**
 * The bars and the top line for the current scroll offset, plus `changesAt`, which the feed's
 * scroll handler asks before it re-renders.
 *
 * Every scroll event used to set state and re-render the whole feed, because the bars are a
 * function of the offset. They change only when a row boundary crosses the top of the viewport,
 * though, so the handler now asks the same rules what the answer WOULD be at the new offset and
 * re-renders only when it differs from the one on screen. Measured 2026-10-05 on six open cards
 * scrolled continuously for 20 seconds: 2,414 feed renders before and 422 after, with the same
 * sequence of bars.
 *
 * `scrollTop` is read at every render from the feed's ref rather than held in state, so a render
 * for any other reason -- a delta, a re-measure -- answers for where the reader actually is.
 */
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
  const barHeight = () => stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE;

  // `measurementsCache` is the public mirror of the private getMeasurements(); the
  // getVirtualItems() call in the feed refreshes it every render, so it holds current geometry
  // for every row, including those scrolled off. `virtualItems` stays a dependency so a
  // re-measure is picked up even without a scroll.
  const answer = useMemo(
    () => answerAt(items, rowVirtualizer.measurementsCache, rowItems.length, scrollTop, barHeight(), unloadedUserBar),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollTop, virtualItems, items, rowItems.length, unloadedUserBar],
  );

  // What the scroll handler compares against, kept current with every render.
  const latest = useRef({ answer, items, rowCount: rowItems.length, unloadedUserBar });
  latest.current = { answer, items, rowCount: rowItems.length, unloadedUserBar };
  const changesAt = useRef((offset: number): boolean => {
    const now = latest.current;
    const next = answerAt(now.items, rowVirtualizer.measurementsCache, now.rowCount, offset, barHeight(), now.unloadedUserBar);
    return !sameAnswer(next, now.answer);
  }).current;

  const { stickyUserIndex, stickyCurrentIndex, topRowIndex } = answer;
  // Only ever a user row, which is always a single event, but resolved through the
  // shared accessor so this does not have to be revisited if another multi-event row
  // kind appears.
  const stickyUserItem = stickyUserIndex === null ? null : items[stickyUserIndex];
  const stickyUser: ActivityEvent | null = stickyUserItem ? leadEvent(stickyUserItem) : null;

  // Event row currently straddling the top of the viewport: its heading has
  // scrolled past, but its content is still on screen. Drives the secondary
  // sticky which lets the viewer jump back to that row's start.
  const stickyCurrent: DisplayItem | null =
    stickyCurrentIndex === null ? null : items[stickyCurrentIndex] ?? null;

  // The transcript line at the top of the viewport: the first row still on screen.
  //
  // This is what gets remembered, and it is deliberately a transcript event rather than the
  // offset it sits at. An offset means nothing on the next visit -- rows carry estimated heights
  // until they are measured, the feed opens on a window of the newest events rather than the whole
  // thread, and a live session has grown in the meantime -- where the event is the one thing every
  // one of those preserves.
  const topItem = topRowIndex === null ? undefined : rowItems[topRowIndex];
  // The live tail counts rows in the sidecar's projection rather than lines in the transcript,
  // so it is not an anchor -- and a reader sitting on it is at the end, which needs none.
  const topEvent = !topItem || topItem.kind === "tail" ? null : leadEvent(topItem);

  return { changesAt, stickyCurrent, stickyCurrentIndex, stickyUser, stickyUserIndex, topEvent };
}
