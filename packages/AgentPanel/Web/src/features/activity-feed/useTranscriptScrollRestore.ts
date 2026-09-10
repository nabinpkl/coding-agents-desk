// Coming back to where a session was being read, and writing down where it is left.
//
// A restore is several scrolls, not one -- the jump, then the virtualiser correcting it
// as rows measure -- which is why the hold and the settle delay below exist. Both numbers
// are the reason this is its own module rather than three effects in the feed.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { leadEvent, type DisplayItem } from "@/features/activity-feed/activityDisplayItems";
import {
  forgetTranscriptAnchor,
  loadTranscriptAnchor,
  rememberTranscriptAnchor,
} from "@/features/activity-feed/transcriptScrollStore";

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
 * Holds the reader's place while the rows settle, then remembers where they stopped.
 *
 * Returns nothing: everything it does is a scroll, and the feed's own render never reads
 * the hold. `holdingEvent` stays inside because letting it out would invite a caller to
 * treat a transient hold as state worth rendering.
 */
export function useTranscriptScrollRestore({
  following,
  parentRef,
  pause,
  rowItems,
  rowVirtualizer,
  sessionId,
  source,
  topEvent,
  virtualItems,
}: {
  following: boolean;
  parentRef: RefObject<HTMLDivElement | null>;
  pause: () => void;
  /** The rows on screen, including the live tail the durable list does not know about. */
  rowItems: readonly (DisplayItem | { kind: "tail" })[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  sessionId: string;
  source: string;
  topEvent: number | null;
  virtualItems: { index: number }[];
}): void {
  const restoredFor = useRef<string | null>(null);
  // Puts the reader back where they were reading, as soon as there are rows to land on.
  //
  // Only for a session that was left away from the tail: following it is the default, so a session
  // with nothing stored is restored by doing nothing, which is also what a reload of a live thread
  // should do. `pause()` first, or the tail-follower's own ResizeObserver snaps the scroll back to
  // the bottom the moment the next row is measured.
  //
  // An anchor older than the loaded window resolves to the window's first row, which is the
  // nearest place to it that exists -- and landing there is what asks for the page before it.
  // The transcript line a restore is currently holding at the top of the viewport, or null once it
  // has let go. The line rather than its row, because paging older events in renumbers every row
  // and a held number would then hold somebody else.
  const [holdingEvent, setHoldingEvent] = useState<number | null>(null);
  useLayoutEffect(() => {
    const key = `${source}:${sessionId}`;
    if (restoredFor.current === key || rowItems.length === 0) return;
    const anchor = loadTranscriptAnchor({ source, sessionId });
    const rowIndex = anchor === null ? -1 : rowItems.findIndex(
      (item) => item.kind !== "tail" && leadEvent(item).index >= anchor,
    );
    // Nothing to put back, or nothing left to put it back on. Either way this session is answered,
    // and every scroll from here is the reader's.
    if (rowIndex < 0) {
      restoredFor.current = key;
      return;
    }
    // The rows exist before the virtualiser has measured any of them, and a restore that gave up
    // there would give up for good. Left unanswered so the next commit tries again.
    if (!rowVirtualizer.measurementsCache[rowIndex] || !parentRef.current) return;
    restoredFor.current = key;
    pause();
    setHoldingEvent(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sessionId, rowItems, virtualItems, rowVirtualizer, pause]);

  /**
   * Puts the held row back at the top after every commit that could have moved it.
   *
   * No dependency list on purpose: what moves it is a row being measured or collapsed, and those
   * arrive as ordinary renders rather than as a value this could watch. Re-applying costs nothing
   * once the answer stops changing, because writing the offset it already has is not a scroll.
   */
  useLayoutEffect(() => {
    if (holdingEvent === null) return;
    const rowIndex = rowItems.findIndex(
      (item) => item.kind !== "tail" && leadEvent(item).index >= holdingEvent,
    );
    if (rowIndex >= 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
  });

  // The hold ends on its own, and early if the reader takes over -- fighting somebody who is
  // already scrolling is worse than landing a little short of where they were.
  useEffect(() => {
    if (holdingEvent === null) return;
    const el = parentRef.current;
    const release = () => setHoldingEvent(null);
    const timer = setTimeout(release, RESTORE_HOLD_MS);
    el?.addEventListener("wheel", release, { passive: true });
    el?.addEventListener("touchstart", release, { passive: true });
    el?.addEventListener("pointerdown", release, { passive: true });
    window.addEventListener("keydown", release, true);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener("wheel", release);
      el?.removeEventListener("touchstart", release);
      el?.removeEventListener("pointerdown", release);
      window.removeEventListener("keydown", release, true);
    };
  }, [holdingEvent]);

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
    if (restoredFor.current !== `${source}:${sessionId}` || holdingEvent !== null) return;
    const timer = setTimeout(() => {
      const session = { source, sessionId };
      // Back at the end is not a place worth keeping: it is where a session opens anyway, and an
      // entry saying so would outlive the reading it came from.
      if (following || topEvent === null) forgetTranscriptAnchor(session);
      else rememberTranscriptAnchor(session, topEvent);
    }, SCROLL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [source, sessionId, following, topEvent, holdingEvent]);
}
