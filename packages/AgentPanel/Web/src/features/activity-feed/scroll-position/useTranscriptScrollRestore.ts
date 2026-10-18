// Coming back to where a session was being read, and writing down where it is left.
//
// A restore is several scrolls, not one -- the jump, then the virtualiser correcting it
// as rows measure -- which is why the hold and the settle delay below exist. Both numbers
// are the reason this is its own module rather than three effects in the feed.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { Virtualizer } from "@tanstack/react-virtual";
import { isEventItem, leadEvent, type DisplayItem, type FeedItem } from "@/features/activity-feed/rows/activityDisplayItems";
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
 * Finds the row an anchor names, preferring identity over position, or -1 while it may still be
 * read.
 *
 * A backend projection can be rebuilt with the same messages at different indices. An exact event
 * id therefore wins whenever it is held. Until the rows around the anchor have been read
 * (`read`), an anchor that is not held is left pending rather than matched by position: the
 * nearest held row may be in another range entirely, and landing there would read as having been
 * restored to the wrong place. Once they have been read, the index is the fallback, for anchors
 * stored without an id and for a line the view does not show: the first row at or after it, or the
 * last row when the session is shorter than the remembered position.
 */
function findAnchorRow(
  rowItems: readonly (FeedItem | { kind: "tail" })[],
  anchor: TranscriptScrollAnchor,
  read: boolean,
): number {
  const durable = rowItems
    .map((item, index) => item.kind === "tail" || !isEventItem(item) ? null : { item, index })
    .filter((entry): entry is { item: DisplayItem; index: number } => entry !== null);
  if (durable.length === 0) return -1;
  if (anchor.eventId) {
    const exact = durable.find(({ item }) => leadEvent(item).id === anchor.eventId);
    if (exact) return exact.index;
  }
  if (!read) return -1;
  const byIndex = durable.find(({ item }) => leadEvent(item).index >= anchor.index);
  return (byIndex ?? durable[durable.length - 1]!).index;
}

/**
 * Holds the reader's place while the rows settle, then remembers where they stopped.
 *
 * A saved place the feed does not hold is read with one page around it (`loadAround`, ADR-0125),
 * where this used to page back from the top of the window until it was loaded, however far that
 * was. Returns whether that page is still on its way. The feed hides the rows while that is true so
 * the opening window's first row is not mistaken for the saved place.
 * `holdingEvent` stays inside because letting it out would invite a caller to treat a
 * transient hold as state worth rendering.
 */
export function useTranscriptScrollRestore({
  following,
  loadAround,
  parentRef,
  pause,
  rowItems,
  rowVirtualizer,
  sessionId,
  source,
  timelineEpoch,
  topEvent,
  virtualItems,
}: {
  following: boolean;
  /** Opens a range around a position, for a saved place the feed does not hold. */
  loadAround: (position: number) => Promise<void>;
  parentRef: RefObject<HTMLDivElement | null>;
  pause: () => void;
  /** The rows on screen, including the live tail the durable list does not know about. */
  rowItems: readonly (FeedItem | { kind: "tail" })[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  sessionId: string;
  source: string;
  /** Changes whenever the timeline replaces its window, including after a sidecar restart. */
  timelineEpoch: number;
  topEvent: ActivityEvent | null;
  virtualItems: { index: number }[];
}): { restoring: boolean } {
  // Left uncompiled on purpose. It is handed the feed's TanStack Virtual virtualizer, one object
  // whose measurements change inside it, which React Compiler cannot see: memoized on that object,
  // this would keep answering from geometry the rows have already left.
  "use no memo";
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
  // and their indices have just been rebuilt. An anchor the feed does not hold stays pending while
  // the page around it is read.
  const [holdingEvent, setHoldingEvent] = useState<TranscriptScrollAnchor | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<TranscriptScrollAnchor | null>(null);
  // The restore key whose page around the anchor has been asked for, and whether it has come back.
  const [around, setAround] = useState<{ key: string; read: boolean } | null>(null);
  useLayoutEffect(() => {
    const key = `${source}:${sessionId}:${timelineEpoch}`;
    if (restoredFor.current === key || rowItems.length === 0) return;
    const anchor = loadTranscriptAnchor({ source, sessionId });
    if (anchor === null) {
      // The restore's state is set from this effect because whether it can land is layout: the
      // virtualiser measures the anchor's row only after a commit.
      // oxlint-disable-next-line react/set-state-in-effect
      setPendingAnchor((current) => current === null ? current : null);
      restoredFor.current = key;
      return;
    }
    const read = around?.key === key && around.read;
    const rowIndex = findAnchorRow(rowItems, anchor, read);
    if (rowIndex < 0) {
      // Not held. Detach the tail follower now, or its resize handling keeps the viewport at the
      // newest rows, then read the rows around the anchor once.
      pause();
      setPendingAnchor((current) =>
        current?.index === anchor.index && current?.eventId === anchor.eventId
          ? current
          : anchor,
      );
      if (around?.key !== key) {
        setAround({ key, read: false });
        loadAround(anchor.index).then(
          () => setAround((current) => current?.key === key ? { key, read: true } : current),
          (error: unknown) => {
            console.error(`[restore] could not read the rows around ${anchor.eventId ?? anchor.index}`, error);
            setAround((current) => current?.key === key ? { key, read: true } : current);
          },
        );
      }
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
  }, [source, sessionId, timelineEpoch, around, rowItems, virtualItems, rowVirtualizer, pause, loadAround]);

  /**
   * Puts the held place back at the top -- the row, and as far into it as the reader was -- after
   * every commit that could have moved it.
   *
   * No dependency list on purpose: what moves it is a row being measured or collapsed, and those
   * arrive as ordinary renders rather than as a value this could watch. Re-applying costs nothing
   * once the answer stops changing, because writing the offset it already has is not a scroll.
   */
  useLayoutEffect(() => {
    if (holdingEvent === null) return;
    const rowIndex = findAnchorRow(rowItems, holdingEvent, true);
    if (rowIndex < 0) return;
    const row = rowVirtualizer.measurementsCache[rowIndex];
    const offset = holdingEvent.offset ?? 0;
    if (offset === 0 || !row) {
      rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
      return;
    }
    // Inside the row, never past it: an offset taken at another width can outrun the row's
    // height here, and spilling into the next event would be a place the reader never was.
    rowVirtualizer.scrollToOffset(row.start + Math.min(offset, Math.max(0, row.size - 1)), { align: "start" });
  });

  // The hold ends on its own, and early if the reader takes over -- fighting somebody who is
  // already scrolling is worse than landing a little short of where they were. A pending
  // restore has no hold timer: it waits for its one page, but a real input cancels it immediately.
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
   *
   * The scroll itself restarts it too, not only a change of top line. A scroll inside one tall
   * row re-renders nothing (`changesAt` in `useStickyIndices` asks for a render only when a row
   * boundary crosses the top), so a reader who read down through one long answer used to keep
   * whatever offset was current when that row first reached the top.
   */
  const latest = useLatestRef({ following, rowItems, topEvent });
  useEffect(() => {
    if (restoredFor.current !== `${source}:${sessionId}:${timelineEpoch}` || holdingEvent !== null) return;
    const el = parentRef.current;
    const write = () => {
      const session = { source, sessionId };
      const { following: atEnd, rowItems: rows, topEvent: top } = latest.current;
      // Back at the end is not a place worth keeping: it is where a session opens anyway, and an
      // entry saying so would outlive the reading it came from.
      if (atEnd || top === null) {
        forgetTranscriptAnchor(session);
        return;
      }
      const rowIndex = findAnchorRow(rows, { index: top.index, eventId: top.id }, true);
      const row = rowIndex < 0 ? undefined : rowVirtualizer.measurementsCache[rowIndex];
      // Negative when the top line is a gap and the event is the row under it, which is its start.
      const offset = row && el ? Math.max(0, el.scrollTop - row.start) : 0;
      rememberTranscriptAnchor(session, top.index, top.id, offset);
    };
    let timer = setTimeout(write, SCROLL_SETTLE_MS);
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(write, SCROLL_SETTLE_MS);
    };
    el?.addEventListener("scroll", settle, { passive: true });
    return () => {
      clearTimeout(timer);
      el?.removeEventListener("scroll", settle);
    };
  }, [source, sessionId, timelineEpoch, following, topEvent, holdingEvent, parentRef, rowVirtualizer]);

  return { restoring: pendingAnchor !== null };
}
