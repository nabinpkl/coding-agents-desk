// Opening the canvas where the reader left it, and keeping saying where that is.
//
// Its own file because it is a hook with a lifecycle rather than a piece of the surface: a
// restore that has to wait for content to exist, a hold that keeps asking for the offset while
// the strip is still growing under it, a throttled write, and one final write on the way out.
// See `botCanvasPreferences.ts` for where the offset is actually stored.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadCanvasScroll, storeCanvasScroll, type CanvasScroll } from "@/features/bots/canvas/botCanvasPreferences";

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
 * How long a restore that landed short keeps asking for the offset it was aiming at.
 *
 * Assigning past the end of a scroller lands at the end, and this scroller has an end that moves.
 * Measured against this repo's own Bots: the strip is 4569px wide when the restore fires and
 * 4911px a moment later, as the cards that opened finish filling in. So a restore to 3927 landed
 * at 3585, the settle timer below wrote THAT down, and every reload walked the reader a little
 * further from where they had been reading. A ratchet, with nothing that ever walked it back.
 *
 * Re-applied on a frame rather than on a render, because what moves the end is a card measuring
 * itself, and that reaches this component as nothing at all.
 *
 * Long enough to cover the cards settling, short enough that a reader who reloads and reaches
 * straight for the canvas is not fought for long -- and their own first wheel, touch, press or
 * key ends it early anyway.
 */
const RESTORE_HOLD_MS = 1500;

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
  /**
   * What the canvas is drawn at, and whether that is settled yet.
   *
   * The offset is stored in CONTENT space so it keeps naming the same cards at any scale, which
   * means the restore cannot happen until the scale is known. `ready` is what says so: with the
   * zoom mode off it is true from the first layout, and with it on it waits for the strip and the
   * panel to be measured. Without that wait the restore fires against a scale of 1 and lands
   * wherever the stored number happens to point, which looks exactly like having forgotten.
   *
   * `pad` is the room the mode leaves around the canvas to be scrolled into, and so the distance
   * between the scroller's origin and the canvas's own. An offset stored without it would be
   * half a panel out on every visit, in the same direction each time.
   */
  zoom: { scale: number; ready: boolean; pad: { left: number; top: number } },
): () => void {
  const restored = useRef(false);
  const wanted = useRef<CanvasScroll | null>(null);
  const latest = useRef<CanvasScroll | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The offset a restore is still asking for, in content space, or null once it has let go. */
  const [holding, setHolding] = useState<CanvasScroll | null>(null);

  useLayoutEffect(() => {
    if (restored.current || !zoom.ready) return;
    const el = scroller.current;
    if (!el) return;
    // Read once and held, because this effect runs again on every render until it lands, and what
    // it is looking for cannot change underneath it -- nothing writes the offset until it has.
    wanted.current ??= loadCanvasScroll();
    const { left, top } = wanted.current;
    // Nothing to put back AND nowhere else to put it, so the canvas is already where it belongs
    // and every scroll from here is the reader's. Marked restored rather than left pending, or the
    // first one would be ignored.
    //
    // The second half of that is the room: a stored zero means the canvas's own top-left against
    // the panel's, which with room around the canvas is half a panel along from where an
    // unscrolled scroller sits. So a zero still has somewhere to be put back to.
    if (left === 0 && top === 0 && zoom.pad.left === 0 && zoom.pad.top === 0) {
      restored.current = true;
      return;
    }
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) {
      // Nothing to scroll yet. Normally that means the Bots have not arrived, so the restore waits
      // and this effect runs again when they do. Drawn whole by the zoom mode it means the
      // opposite -- the canvas fits, and always will at this scale -- and leaving the restore
      // pending there would fire it later, at the moment a pinch first gives the scroller some
      // range, yanking the reader off the very point they had just zoomed to.
      if (zoom.scale < 1) restored.current = true;
      return;
    }
    restored.current = true;
    const asked = {
      left: left * zoom.scale + zoom.pad.left,
      top: top * zoom.scale + zoom.pad.top,
    };
    el.scrollLeft = asked.left;
    el.scrollTop = asked.top;
    // Landing short of what was asked for is the browser saying the strip does not reach that far
    // YET, so the offset is held and re-applied until it does. Landing exactly needs no hold: the
    // end only moves outwards while the cards fill in, so an offset that already fits keeps
    // fitting, and a hold is a second and a half of not writing down where the reader goes.
    if (el.scrollLeft < asked.left - 1 || el.scrollTop < asked.top - 1) setHolding({ left, top });
  }, [scroller, content, zoom.ready, zoom.scale, zoom.pad.left, zoom.pad.top]);

  // Asks again, every frame, until the strip is wide enough to answer or the reader takes over.
  useEffect(() => {
    if (holding === null) return;
    const el = scroller.current;
    if (!el) return;
    const release = (): void => setHolding(null);
    let frame = requestAnimationFrame(function again() {
      // Writing the offset it already has is not a scroll, so re-asking after it has landed costs
      // nothing; what it buys is the case where the strip grows again before the hold is over.
      el.scrollLeft = holding.left * zoom.scale + zoom.pad.left;
      el.scrollTop = holding.top * zoom.scale + zoom.pad.top;
      frame = requestAnimationFrame(again);
    });
    // Fighting a reader who is already scrolling is worse than landing short of where they were,
    // so any input of their own ends the hold before the timer does.
    const timeout = setTimeout(release, RESTORE_HOLD_MS);
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("pointerdown", release, { passive: true });
    window.addEventListener("keydown", release, true);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("pointerdown", release);
      window.removeEventListener("keydown", release, true);
    };
  }, [holding, scroller, zoom.scale, zoom.pad.left, zoom.pad.top]);

  // Written from one place, on a timer, rather than beside each of the things that scroll the
  // canvas -- the reader, a card coming into view, a drag creeping at the edge. They all end up
  // here because they all end up as a scroll event.
  const remember = useCallback(() => {
    const el = scroller.current;
    // A hold is the restore still arriving rather than the reader moving: the scrolls it raises
    // say how far the strip can reach so far, not where anybody chose to be, and writing one of
    // those down is exactly how the remembered place walks away from the reader.
    if (!el || !restored.current || holding !== null) return;
    // Back into content space on the way out, so a position taken while zoomed out still names the
    // card it was taken over once the canvas is drawn at some other size.
    latest.current = {
      left: (el.scrollLeft - zoom.pad.left) / zoom.scale,
      top: (el.scrollTop - zoom.pad.top) / zoom.scale,
    };
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) storeCanvasScroll(latest.current);
    }, SCROLL_SETTLE_MS);
  }, [scroller, zoom.scale, zoom.pad.left, zoom.pad.top, holding]);

  // Leaving the canvas is the one scroll that never settles, because the component goes with it.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (latest.current) storeCanvasScroll(latest.current);
  }, []);

  return remember;
}
