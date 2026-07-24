"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Treat the container as "at the end" within this many pixels. This is a
// sub-pixel rounding tolerance (fractional device pixels, flex rounding), NOT
// a "close enough to the bottom" heuristic — re-attachment still requires the
// user to actually reach the last row.
const END_EPSILON_PX = 4;

/**
 * Keep a scroll container pinned to its bottom edge as content grows, and
 * release that pin the moment the user scrolls away — without ever inferring
 * intent from how far the viewport happens to sit from the bottom.
 *
 * Two-state machine, driven only by attributable events:
 *   - FOLLOWING: resized content re-pins the viewport to the bottom.
 *   - BROWSING:  the user scrolled up; content changes leave scrollTop alone.
 *
 * Why this is race-free where a `fromBottom < N` threshold was not:
 *   - Landing at the bottom is driven by a ResizeObserver on the *measured*
 *     content element, so estimated row heights never decide where we land.
 *   - Detaching is attributed by scrollTop *direction*. Content growth changes
 *     scrollHeight but never scrollTop, so only a real user drag can decrease
 *     scrollTop — a growth storm can't be misread as "the user scrolled up".
 *   - Our own bottom-snaps are fenced (`enforcingRef`) and only ever *increase*
 *     scrollTop, so they can't trip the detach path either.
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

  // Intent: attribute a scroll by its direction, sampled only on real scroll
  // events (not during the measurement storm).
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const wentUp = top < lastTopRef.current - 1;
    lastTopRef.current = top;
    if (enforcingRef.current) return; // our own snap, not the user
    if (followingRef.current) {
      if (wentUp) setFollowing(false); // user pulled away from the tail
    } else {
      const fromEnd = el.scrollHeight - top - el.clientHeight;
      if (fromEnd <= END_EPSILON_PX) setFollowing(true); // user returned to the end
    }
  }, [scrollRef, setFollowing]);

  return { following, onScroll, scrollToBottom, pause };
}
