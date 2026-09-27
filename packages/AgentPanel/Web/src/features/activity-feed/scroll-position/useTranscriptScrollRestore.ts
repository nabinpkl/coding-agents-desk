// Coming back to where a session was being read, and writing down where it is left.
//
// A restore is several scrolls, not one -- the jump, then the virtualiser correcting it
// as rows measure -- which is why the hold and the settle delay below exist. Both numbers
// are the reason this is its own module rather than three effects in the feed.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { leadEvent, type DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import {
  forgetTranscriptAnchor,
  loadTranscriptAnchor,
  rememberTranscriptAnchor,
  type TranscriptScrollAnchor,
} from "@/features/activity-feed/scroll-position/transcriptScrollStore";

/**
 * How long a restore keeps holding the line it put back at the top of the viewport.
 *
 * A jump into a virtualised list lands on estimates, and the layout goes on changing under it
 * afterwards as each row that comes into view reports what it really measures. That moves the line
 * the jump was aimed at, and the first version of this fired once and accepted wherever it landed:
 * measured against a real thread in a real browser, a couple of hundred lines late, which is close
 * enough to the end to read as never having been restored at all. So the line is held instead,
 * until the layout stops moving or the reader takes over, whichever comes first.
 *
 * Long enough to cover a window of rows measuring, short enough that a reader who reloads and
 * immediately reaches for the scrollbar is not fought for long -- and their first wheel, touch,
 * press or key ends it early anyway.
 */
const RESTORE_HOLD_MS = 1500;

/**
 * How long the transcript has to sit still before where it is being read is written down.
 *
 * A scroll is hundreds of events and a restore is a handful of corrections; both settle inside
 * this, so each becomes one storage write of a finished position rather than a stream of writes of
 * half-arrived ones.
 */
const SCROLL_SETTLE_MS = 200;

/**
 * Finds the row an anchor names, preferring identity over position.
 *
 * A backend projection can be rebuilt with the same messages at different indices. An exact event id
 * therefore wins whenever it is loaded. The index remains the fallback for old stored anchors and
 * for sources whose rows have no id. An anchor older than the loaded window returns -1 so the feed's
 * normal paging effect can fetch the page that may contain its exact id.
 */
function findAnchorRow(
  rowItems: readonly (DisplayItem | { kind: "tail" })[],
  anchor: TranscriptScrollAnchor,
  canPageOlder: boolean,
): number {
  const durable = rowItems
    .map((item, index) => item.kind === "tail" ? null : { item, index })
    .filter((entry): entry is { item: DisplayItem; index: number } => entry !== null);
  if (durable.length === 0) return -1;

  if (anchor.eventId) {
    const exact = durable.find(({ item }) => leadEvent(item).id === anchor.eventId);
    if (exact) return exact.index;
  }

  const first = durable[0]!;
  // Everything currently loaded is newer than the anchor. Its exact id may be on the next older
  // page, so leave the restore pending rather than jumping to an unrelated row. This check must
  // precede the index fallback: that fallback would otherwise return this same first row and
  // make an older anchor look restored at the top of the opening window. Once paging has reached
  // the beginning, that first row is the nearest place that exists.
  if (leadEvent(first.item).index > anchor.index) return canPageOlder ? -1 : first.index;

  const byIndex = durable.find(({ item }) => leadEvent(item).index >= anchor.index);
  if (byIndex) return byIndex.index;

  const last = durable[durable.length - 1]!;
  // The projection is shorter than the remembered position. Its last row is the nearest place.
  return last.index;
}

/**
 * Holds the reader's place while the rows settle, then remembers where they stopped.
 *
 * Returns whether a saved anchor is still waiting for its page. The feed hides the rows
 * while that is true so the opening window's first row is not mistaken for the saved place.
 * `holdingEvent` stays inside because letting it out would invite a caller to treat a
 * transient hold as state worth rendering.
 */
export function useTranscriptScrollRestore({
  following,
  parentRef,
  pause,
  rowItems,
  rowVirtualizer,
  sessionId,
  source,
  timelineEpoch,
  topEvent,
  virtualItems,
  windowStart,
}: {
  following: boolean;
  parentRef: RefObject<HTMLDivElement | null>;
  pause: () => void;
  /** The rows on screen, including the live tail the durable list does not know about. */
  rowItems: readonly (DisplayItem | { kind: "tail" })[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  sessionId: string;
  source: string;
  /** Changes whenever the timeline replaces its window, including after a sidecar restart. */
  timelineEpoch: number;
  /** First loaded event. Above zero means there is still an older page to fetch. */
  windowStart: number;
  topEvent: ActivityEvent | null;
  virtualItems: { index: number }[];
}): { restoring: boolean } {
  const restoredFor = useRef<string | null>(null);
  // Puts the reader back where they were reading, as soon as there are rows to land on.
  //
  // Only for a session that was left away from the tail: following it is the default, so a session
  // with nothing stored is restored by doing nothing, which is also what a reload of a live thread
  // should do. `pause()` first, or the tail-follower's own ResizeObserver snaps the scroll back to
  // the bottom the moment the next row is measured.
  //
  // The epoch is part of the restore key because a sidecar restart replaces the projection without
  // remounting this component. The saved event is then still the right place even though the rows
  // and their indices have just been rebuilt. An anchor older than the loaded window stays pending
  // so the feed's paging effect can fetch the page that may contain its exact id.
  const [holdingEvent, setHoldingEvent] = useState<TranscriptScrollAnchor | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<TranscriptScrollAnchor | null>(null);
  useLayoutEffect(() => {
    const key = `${source}:${sessionId}:${timelineEpoch}`;
    if (restoredFor.current === key || rowItems.length === 0) return;
    const anchor = loadTranscriptAnchor({ source, sessionId });
    if (anchor === null) {
      setPendingAnchor((current) => current === null ? current : null);
      restoredFor.current = key;
      return;
    }
    const rowIndex = findAnchorRow(rowItems, anchor, windowStart > 0);
    if (rowIndex < 0) {
      // The anchor is older than the opening window. Detach the tail follower now, or its
      // resize handling keeps the viewport at the newest rows while the paging effect works
      // backwards from the top, and the next page stops asking for the one before it.
      pause();
      setPendingAnchor((current) =>
        current?.index === anchor.index && current?.eventId === anchor.eventId
          ? current
          : anchor,
      );
      return;
    }
    // The rows exist before the virtualiser has measured any of them, and a restore that gave up
    // there would give up for good. Left unanswered so the next commit tries again.
    if (!rowVirtualizer.measurementsCache[rowIndex] || !parentRef.current) {
      pause();
      setPendingAnchor((current) =>
        current?.index === anchor.index && current?.eventId === anchor.eventId
          ? current
          : anchor,
      );
      return;
    }
    setPendingAnchor((current) => current === null ? current : null);
    restoredFor.current = key;
    pause();
    setHoldingEvent(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sessionId, timelineEpoch, windowStart, rowItems, virtualItems, rowVirtualizer, pause]);

  /**
   * Puts the held row back at the top after every commit that could have moved it.
   *
   * No dependency list on purpose: what moves it is a row being measured or collapsed, and those
   * arrive as ordinary renders rather than as a value this could watch. Re-applying costs nothing
   * once the answer stops changing, because writing the offset it already has is not a scroll.
   */
  useLayoutEffect(() => {
    if (holdingEvent === null) return;
    const rowIndex = findAnchorRow(rowItems, holdingEvent, windowStart > 0);
    if (rowIndex >= 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
  });

  // The hold ends on its own, and early if the reader takes over -- fighting somebody who is
  // already scrolling is worse than landing a little short of where they were. A pending
  // restore has no hold timer: it waits for its page, but a real input cancels it immediately.
  useEffect(() => {
    if (holdingEvent === null && pendingAnchor === null) return;
    const el = parentRef.current;
    const key = `${source}:${sessionId}:${timelineEpoch}`;
    const release = () => {
      restoredFor.current = key;
      setHoldingEvent(null);
      setPendingAnchor(null);
    };
    const timer = holdingEvent === null ? null : setTimeout(release, RESTORE_HOLD_MS);
    el?.addEventListener("wheel", release, { passive: true });
    el?.addEventListener("touchstart", release, { passive: true });
    el?.addEventListener("pointerdown", release, { passive: true });
    window.addEventListener("keydown", release, true);
    return () => {
      if (timer !== null) clearTimeout(timer);
      el?.removeEventListener("wheel", release);
      el?.removeEventListener("touchstart", release);
      el?.removeEventListener("pointerdown", release);
      window.removeEventListener("keydown", release, true);
    };
  }, [holdingEvent, pendingAnchor, source, sessionId, timelineEpoch]);

  /**
   * Records where the session is being read, once the scrolling stops.
   *
   * On a delay because a restore is itself several scrolls -- the jump, then the virtualiser
   * correcting it as rows measure -- and each of those passes through here with the position
   * half-arrived. Every one of them restarts this timer, so what lands in storage is where the
   * reading ENDED, which is what stops a reload writing the top of the window over the place it
   * just put the reader back on. It also costs one write per flick rather than one per frame.
   */
  useEffect(() => {
    if (restoredFor.current !== `${source}:${sessionId}:${timelineEpoch}` || holdingEvent !== null) return;
    const timer = setTimeout(() => {
      const session = { source, sessionId };
      // Back at the end is not a place worth keeping: it is where a session opens anyway, and an
      // entry saying so would outlive the reading it came from.
      if (following || topEvent === null) forgetTranscriptAnchor(session);
      else rememberTranscriptAnchor(session, topEvent.index, topEvent.id);
    }, SCROLL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [source, sessionId, timelineEpoch, following, topEvent, holdingEvent]);

  return { restoring: pendingAnchor !== null };
}
