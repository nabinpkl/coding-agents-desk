"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Treat the container as "at the end" within this many pixels. This is a
// sub-pixel rounding tolerance (fractional device pixels, flex rounding), NOT
// a "close enough to the bottom" heuristic — re-attachment still requires the
// user to actually reach the last row.
const END_EPSILON_PX = 4;

/**
 * How long an upward input keeps authorizing a detach. Covers the gap between
 * the last wheel/touch event of a flick and the scroll event it produces,
 * without letting one flick authorize an unrelated clamp a moment later.
 */
const UPWARD_INTENT_WINDOW_MS = 250;

/**
 * How far in from the scroller's right edge a press counts as grabbing its scrollbar. Wide enough
 * for an overlay scrollbar, which takes no layout width and so cannot be told apart by
 * `offsetX > clientWidth` the way a classic one can.
 */
const SCROLLBAR_GRAB_PX = 16;

/** Keys that ask the container to move towards earlier content. */
const UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keep a scroll container pinned to its bottom edge as content grows, and
 * release that pin the moment the user scrolls away — without ever inferring
 * intent from how far the viewport happens to sit from the bottom.
 *
 * Two-state machine, driven only by attributable events:
 *   - FOLLOWING: resized content, or a scroll no input asked for that leaves
 *                the viewport short of the end, re-pins it to the bottom.
 *   - BROWSING:  the user scrolled up; content changes leave scrollTop alone.
 *
 * Landing at the bottom is driven by a ResizeObserver on the *measured* content
 * element, so estimated row heights never decide where we land, and our own
 * bottom-snaps are fenced (`enforcingRef`) and only ever *increase* scrollTop,
 * so they can never trip the detach path.
 *
 * Detaching cannot be decided by the scroll event alone. A `scroll` event is
 * unattributed and it is delivered in the NEXT rendering update, coalesced, so
 * its position and the `scrollHeight` we read when handling it can come from
 * two different layouts. Streaming produces exactly that pair: the live tail
 * hands off to a durable row (the content shrinks, the browser clamps scrollTop
 * down) and the next tail immediately grows the content back, so by delivery
 * time the decrease looks like a pull away from a much taller list. That read
 * "the user scrolled up" while the viewport sat on the last row.
 *
 * So a decrease detaches only when an input asked for it: an upward wheel,
 * touch drag or key within the last {@link UPWARD_INTENT_WINDOW_MS}, or a press
 * held on the scrollbar. Anything else that leaves a following viewport short
 * of the end is layout, and is pinned back to the bottom.
 *
 * There used to be a second way to detach: a decrease whose content height had
 * not moved between two samples, meant to cover a drag of the native scrollbar.
 * Two samples cannot see what happened between them. Measured 2026-10-08 at the
 * end of every assistant message: the live row hands off to its durable row,
 * which mounts at its estimated height, so within ONE frame the content dips
 * (3457 to 2884px), the browser clamps scrollTop, and the virtualizer measures
 * the row back to exactly 3457. The ResizeObserver sees no change and never
 * re-pins, and the scroll event saw "up, height held" and detached. The
 * scrollbar is now an input like the others, read off the press itself.
 *
 * `active` gates observer setup on the content tree being mounted (the feed
 * renders loading/empty placeholders first, when the refs are still null).
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  sizedRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): {
  following: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
  pause: () => void;
} {
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  const enforcingRef = useRef(false);
  const upwardIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastTouchYRef = useRef<number | null>(null);
  // A press on the scrollbar, held until it is let go: the drag that follows fires no input the
  // page sees, so the press is the only evidence the reader is moving it.
  const scrollbarHeldRef = useRef(false);
  const [following, setFollowingState] = useState(true);

  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const snapToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    enforcingRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
    // Release the fence after the browser has dispatched the scroll event this
    // write triggers, so onScroll can distinguish it from a user gesture.
    requestAnimationFrame(() => {
      enforcingRef.current = false;
    });
  }, [scrollRef]);

  const scrollToBottom = useCallback(() => {
    setFollowing(true);
    snapToBottom();
  }, [setFollowing, snapToBottom]);

  // User restructured the content (collapse/expand, jump-to-message). Detach so
  // the resize/scroll it causes is not re-pinned to the tail.
  const pause = useCallback(() => {
    setFollowing(false);
  }, [setFollowing]);

  // Tail enforcement: re-pin whenever the measured content height changes.
  useEffect(() => {
    if (!active) return;
    const sized = sizedRef.current;
    if (!sized) return;
    const ro = new ResizeObserver(() => {
      if (followingRef.current) snapToBottom();
    });
    ro.observe(sized);
    return () => ro.disconnect();
  }, [active, sizedRef, snapToBottom]);

  // Record when an input last asked to move towards earlier content. Only the
  // input can say that; the scroll event it produces cannot, and neither can a
  // clamp that looks identical to it. Note the direction test: a flick DOWNWARD
  // at the tail moves nothing but still fires events, and must not authorize the
  // clamp that a hand-off happens to deliver a moment later.
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    const markUpward = () => {
      upwardIntentAtRef.current = performance.now();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) markUpward();
    };
    const onTouchStart = (event: TouchEvent) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y == null) return;
      const previous = lastTouchYRef.current;
      lastTouchYRef.current = y;
      // A finger travelling DOWN the screen drags earlier content into view.
      if (previous != null && y > previous) markUpward();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (UPWARD_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) markUpward();
    };
    // A press on the scrollbar is dispatched to the scroller itself, never to a row inside it.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el && event.offsetX >= el.clientWidth - SCROLLBAR_GRAB_PX) {
        scrollbarHeldRef.current = true;
      }
    };
    const onPointerUp = () => {
      scrollbarHeldRef.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    // On window: scrolling by keyboard does not require focus to be inside the
    // feed, and usually is not.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, scrollRef]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const wentUp = top < lastTopRef.current - 1;
    const fromEnd = el.scrollHeight - top - el.clientHeight;
    lastTopRef.current = top;
    if (enforcingRef.current) return; // our own snap, not the user
    if (followingRef.current) {
      if (fromEnd <= END_EPSILON_PX) return;
      const pulledUp =
        scrollbarHeldRef.current
        || performance.now() - upwardIntentAtRef.current <= UPWARD_INTENT_WINDOW_MS;
      // The reader asked to go up: let them. Short of the end for any other reason is layout,
      // which a viewport that is following does not get to keep.
      if (wentUp && pulledUp) setFollowing(false);
      else if (!pulledUp) snapToBottom();
    } else {
      if (fromEnd <= END_EPSILON_PX) setFollowing(true); // user returned to the end
    }
  }, [scrollRef, setFollowing]);

  return { following, onScroll, scrollToBottom, pause };
}
