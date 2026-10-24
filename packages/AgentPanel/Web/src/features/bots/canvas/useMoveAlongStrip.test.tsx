// Carrying a card past the edge of the screen: the strip scrolls under a card held at the edge, and
// the card has to travel with the hand rather than ride back with the strip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMoveAlongStrip } from "@/features/bots/canvas/useMoveAlongStrip";

/** Five cards 100 wide, 12 apart, in a scroller 300 wide that can scroll 400 more. */
const CARD = 100;
const GAP = 12;
const VIEW = 300;
const MAX_SCROLL = 400;

function stage() {
  let scroll = 0;
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollLeft", {
    get: () => scroll,
    set: (value: number) => {
      scroll = Math.max(0, Math.min(value, MAX_SCROLL));
    },
  });
  scroller.getBoundingClientRect = () => ({ left: 0, right: VIEW, width: VIEW }) as DOMRect;
  const list = document.createElement("ul");
  list.getBoundingClientRect = () => ({ left: -scroll }) as DOMRect;
  for (let index = 0; index < 5; index += 1) {
    const card = document.createElement("li");
    card.getBoundingClientRect = () => ({ left: index * (CARD + GAP) - scroll, width: CARD }) as DOMRect;
    list.append(card);
  }
  scroller.append(list);
  return { scroller, list, scrolled: () => scroll };
}

describe("useMoveAlongStrip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries a card held at the edge as far as the strip scrolls, and drops it past the screen", () => {
    const { scroller, list, scrolled } = stage();
    const onDrop = vi.fn();
    const { result } = renderHook(() =>
      useMoveAlongStrip({ canvas: { current: scroller }, list: { current: list }, gap: GAP, onDrop }),
    );

    act(() => result.current.start(0, 50));
    // Into the right edge: the card's centre is past the second and third cards, the last two are
    // off screen.
    act(() => result.current.to(290));
    expect(result.current.offsetOf(2)).toBe(-(CARD + GAP));
    expect(result.current.offsetOf(4)).toBe(0);

    // Held still at the edge, which sends no pointer events: the strip scrolls to its end and the
    // card goes with it, past both cards that were off screen.
    act(() => vi.advanceTimersByTime(16 * 40));
    expect(scrolled()).toBe(MAX_SCROLL);
    expect(result.current.offsetOf(0)).toBe(240 + MAX_SCROLL);
    expect(result.current.offsetOf(4)).toBe(-(CARD + GAP));
    // And it stopped there, rather than asking for a frame forever at the end of the strip.
    expect(vi.getTimerCount()).toBe(0);

    act(() => result.current.end());
    expect(onDrop).toHaveBeenCalledWith(0, 4);
  });

  it("stops scrolling once the hand leaves the edge, keeping what it scrolled", () => {
    const { scroller, list, scrolled } = stage();
    const onDrop = vi.fn();
    const { result } = renderHook(() =>
      useMoveAlongStrip({ canvas: { current: scroller }, list: { current: list }, gap: GAP, onDrop }),
    );

    act(() => result.current.start(0, 50));
    act(() => result.current.to(290));
    act(() => vi.advanceTimersByTime(16 * 10));
    const reached = scrolled();
    expect(reached).toBeGreaterThan(0);
    act(() => result.current.to(150));
    act(() => vi.advanceTimersByTime(16 * 10));
    expect(scrolled()).toBe(reached);
    // The pointer came back 140, and the strip it is over has moved on by what was scrolled.
    expect(result.current.offsetOf(0)).toBe(100 + reached);
  });
});
