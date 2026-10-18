"use client";

// Which bars to pin over the transcript, and which transcript line is at the top.
//
// The rules themselves are in `activityStickyHeaders.ts`, deliberately without React so
// they can be tested with no virtualiser. This is the part that reads the live geometry
// and hands the answers to the feed: all three read the same measurement cache, and
// separating one from the others is how they drift.

import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import {
  isEventItem,
  leadEvent,
  type DisplayItem,
  type FeedItem,
} from "@/features/activity-feed/rows/activityDisplayItems";
import {
  selectStickyCurrentIndex,
  selectUserBar,
  type StickyMeasurement,
  type UserBar,
} from "@/features/activity-feed/sticky-headers/activityStickyHeaders";

/** Fallback for the sticky bar's height before it has rendered once. */
const STICKY_HEIGHT_ESTIMATE = 44;

interface StickyAnswer {
  userBar: UserBar;
  stickyCurrentIndex: number | null;
  /** The row at the top of the viewport, as an index into `rowItems`. */
  topRowIndex: number | null;
}

/** Where the user bar's answer comes from the sidecar: the position asked about, and whether a message came back. */
export interface RemoteUserBar {
  before: number;
  found: boolean;
}

/** The three answers for one scroll offset, from one read of the measurement cache. */
function answerAt(
  items: FeedItem[],
  measurements: readonly (StickyMeasurement & { end: number })[],
  rowCount: number,
  scrollTop: number,
  barHeight: number,
  oldestStart: number | null,
  remote: RemoteUserBar | null,
): StickyAnswer {
  if (items.length === 0) return { userBar: null, stickyCurrentIndex: null, topRowIndex: null };
  const userBar = selectUserBar(items, measurements, scrollTop, barHeight, oldestStart);
  // A bar the sidecar has not answered for, or answered with nothing, takes no room.
  const barShown =
    userBar !== null && ("row" in userBar || (remote !== null && remote.before === userBar.before && remote.found));
  const stickyCurrentIndex = selectStickyCurrentIndex(
    items,
    measurements,
    scrollTop,
    barShown ? barHeight : 0,
    userBar !== null && "row" in userBar ? userBar.row : null,
  );
  let topRowIndex: number | null = null;
  const limit = Math.min(rowCount, measurements.length);
  for (let index = 0; index < limit; index++) {
    if (measurements[index]!.end > scrollTop) {
      topRowIndex = index;
      break;
    }
  }
  return { userBar, stickyCurrentIndex, topRowIndex };
}

function sameBar(left: UserBar, right: UserBar): boolean {
  if (left === null || right === null) return left === right;
  return "row" in left ? "row" in right && left.row === right.row : "before" in right && left.before === right.before;
}

function sameAnswer(left: StickyAnswer, right: StickyAnswer): boolean {
  return (
    sameBar(left.userBar, right.userBar) &&
    left.stickyCurrentIndex === right.stickyCurrentIndex &&
    left.topRowIndex === right.topRowIndex
  );
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
  oldestStart,
  remote,
  rowItems,
  rowVirtualizer,
  scrollTop,
  stickyHeaderRef,
  virtualItems,
}: {
  items: FeedItem[];
  /** Where the oldest held range starts, or null for a source the sidecar cannot be asked about. */
  oldestStart: number | null;
  /** The sidecar's answer for the bar, when it has been asked. */
  remote: RemoteUserBar | null;
  /** The rows on screen, including the live tail the durable list does not know about. */
  rowItems: readonly (FeedItem | { kind: "tail" })[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollTop: number;
  stickyHeaderRef: RefObject<HTMLButtonElement | null>;
  virtualItems: { index: number; end: number }[];
}) {
  // Left uncompiled on purpose. It is handed the feed's TanStack Virtual virtualizer, one object
  // whose measurements change inside it, which React Compiler cannot see: memoized on that object,
  // this would keep answering from geometry the rows have already left.
  "use no memo";
  const barHeight = () => stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE;

  // `measurementsCache` is the public mirror of the private getMeasurements(); the
  // getVirtualItems() call in the feed refreshes it every render, so it holds current geometry
  // for every row, including those scrolled off. `virtualItems` stays a dependency so a
  // re-measure is picked up even without a scroll.
  //
  // The bar's height is read as last drawn, while rendering: the top line is the one under the bar,
  // and its height is layout, which nothing reports as a value. Harmless uncompiled, where each
  // render reads it afresh. For the same reason the list names what moves the geometry rather than
  // the geometry itself, which is one object the virtualizer changes in place.
  const answer = useMemo(
    () =>
      // oxlint-disable-next-line react/refs, react/memo-dependencies
      answerAt(items, rowVirtualizer.measurementsCache, rowItems.length, scrollTop, barHeight(), oldestStart, remote),
    [scrollTop, virtualItems, items, rowItems.length, oldestStart, remote],
  );

  // What the scroll handler compares against, as of the last commit: a scroll arrives after one.
  const latest = useLatestRef({ answer, items, rowCount: rowItems.length, oldestStart, remote });
  const changesAt = useCallback(
    (offset: number): boolean => {
      const now = latest.current;
      const height = stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE;
      const next = answerAt(
        now.items,
        rowVirtualizer.measurementsCache,
        now.rowCount,
        offset,
        height,
        now.oldestStart,
        now.remote,
      );
      return !sameAnswer(next, now.answer);
    },
    [latest, rowVirtualizer, stickyHeaderRef],
  );

  const { userBar, stickyCurrentIndex, topRowIndex } = answer;
  const stickyUserIndex = userBar !== null && "row" in userBar ? userBar.row : null;
  // Only ever a user row, which is always a single event, but resolved through the
  // shared accessor so this does not have to be revisited if another multi-event row
  // kind appears.
  const stickyUserItem = stickyUserIndex === null ? null : items[stickyUserIndex];
  const stickyUser: ActivityEvent | null =
    stickyUserItem && isEventItem(stickyUserItem) ? leadEvent(stickyUserItem) : null;

  // Event row currently straddling the top of the viewport: its heading has
  // scrolled past, but its content is still on screen. Drives the secondary
  // sticky which lets the viewer jump back to that row's start.
  const currentItem = stickyCurrentIndex === null ? undefined : items[stickyCurrentIndex];
  const stickyCurrent: DisplayItem | null = currentItem && isEventItem(currentItem) ? currentItem : null;

  // The transcript line at the top of the viewport: the first row still on screen.
  //
  // This is what gets remembered, and it is deliberately a transcript event rather than the
  // offset it sits at. An offset means nothing on the next visit -- rows carry estimated heights
  // until they are measured, the feed opens on a window of the newest events rather than the whole
  // thread, and a live session has grown in the meantime -- where the event is the one thing every
  // one of those preserves.
  // A gap at the top stands for no line, so the place is the row under it, which is what the
  // reader sees next and what a page into the gap keeps still.
  const topOrUnder =
    topRowIndex === null
      ? undefined
      : rowItems[topRowIndex]?.kind === "gap"
        ? rowItems[topRowIndex + 1]
        : rowItems[topRowIndex];
  // The live tail counts rows in the sidecar's projection rather than lines in the transcript,
  // so it is not an anchor -- and a reader sitting on it is at the end, which needs none.
  const topEvent = !topOrUnder || topOrUnder.kind === "tail" || !isEventItem(topOrUnder) ? null : leadEvent(topOrUnder);

  // The position the bar needs the sidecar's answer for, when no held row stands for it.
  const userBarBefore = userBar !== null && "before" in userBar ? userBar.before : null;

  return {
    changesAt,
    stickyCurrent,
    stickyCurrentIndex,
    stickyUser,
    stickyUserIndex,
    topEvent,
    topRowIndex,
    userBarBefore,
  };
}
