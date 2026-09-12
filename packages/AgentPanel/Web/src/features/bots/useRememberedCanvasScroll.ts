// Opening the canvas where the reader left it, and keeping saying where that is.
//
// Its own file because it is a hook with a lifecycle rather than a piece of the surface: a
// restore that has to wait for content to exist, a throttled write, and one final write on the
// way out. See `botCanvasPreferences.ts` for where the offset is actually stored.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { loadCanvasScroll, storeCanvasScroll, type CanvasScroll } from "@/features/bots/botCanvasPreferences";

/**
 * The most often the canvas offset is written, and how long after the last scroll it is written
 * again.
 *
 * A scroll is hundreds of events, and a store write per event is a store write per frame. This
 * throttles them: the first event of a burst schedules the write, the rest only update what it
 * will say, and because the last event always leaves a timer pending, where the reader stopped is
 * always the last thing written.
 */
const SCROLL_SETTLE_MS = 200;

/**
 * Opens the canvas where it was left, and keeps saying where that is.
 *
 * The restore waits for the strip to have somewhere to scroll TO. The Bots arrive on a stream, so
 * the first layout is an empty canvas, and an offset written there is silently clamped to zero by
 * the browser -- indistinguishable, from the reader's side, from having forgotten. `content` is
 * whatever changing means the strip may have grown; the effect re-checks on it until it lands.
 */
export function useRememberedCanvasScroll(
  scroller: React.RefObject<HTMLDivElement | null>,
  content: unknown,
): () => void {
  const restored = useRef(false);
  const wanted = useRef<CanvasScroll | null>(null);
  const latest = useRef<CanvasScroll | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (restored.current) return;
    const el = scroller.current;
    if (!el) return;
    // Read once and held, because this effect runs again on every render until it lands, and what
    // it is looking for cannot change underneath it -- nothing writes the offset until it has.
    wanted.current ??= loadCanvasScroll();
    const { left, top } = wanted.current;
    // Nothing to put back, so the canvas is already where it belongs and every scroll from here is
    // the reader's. Marked restored rather than left pending, or the first one would be ignored.
    if (left === 0 && top === 0) {
      restored.current = true;
      return;
    }
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    restored.current = true;
    el.scrollLeft = left;
    el.scrollTop = top;
  }, [scroller, content]);

  // Written from one place, on a timer, rather than beside each of the things that scroll the
  // canvas -- the reader, a card coming into view, a drag creeping at the edge. They all end up
  // here because they all end up as a scroll event.
  const remember = useCallback(() => {
    const el = scroller.current;
    if (!el || !restored.current) return;
    latest.current = { left: el.scrollLeft, top: el.scrollTop };
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) storeCanvasScroll(latest.current);
    }, SCROLL_SETTLE_MS);
  }, [scroller]);

  // Leaving the canvas is the one scroll that never settles, because the component goes with it.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (latest.current) storeCanvasScroll(latest.current);
  }, []);

  return remember;
}
