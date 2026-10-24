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

function stage(widths: number[] = [CARD, CARD, CARD, CARD, CARD]) {
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
  let laid = 0;
  for (const width of widths) {
    const card = document.createElement("li");
    const left = laid;
    card.getBoundingClientRect = () => ({ left: left - scroll, width }) as DOMRect;
    list.append(card);
    laid += width + GAP;
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

  it("moves a neighbour once the held card's leading edge passes its middle, whatever the held card's width", () => {
    // A wide card beside two narrow ones: centre against centre, it had to travel half its own width
    // too before the first narrow one moved, as if it needed room to fit in the gap.
    const { scroller, list } = stage([300, 100, 100]);
    const onDrop = vi.fn();
    const { result } = renderHook(() =>
      useMoveAlongStrip({ canvas: { current: scroller }, list: { current: list }, gap: GAP, onDrop }),
    );
    act(() => result.current.start(0, 150));
    // Its right edge at 360, short of the narrow card's middle at 362.
    act(() => result.current.to(210));
    expect(result.current.offsetOf(1)).toBe(0);
    act(() => result.current.to(213));
    expect(result.current.offsetOf(1)).toBe(-(300 + GAP));
    act(() => result.current.end());
    expect(onDrop).toHaveBeenCalledWith(0, 1);

    // And leftwards by its left edge: the last card's, at 424, passes the middle of the one before it
    // at 362 after 63, where centre against centre needed 113.
    act(() => result.current.start(2, 250));
    act(() => result.current.to(189));
    expect(result.current.offsetOf(1)).toBe(0);
    act(() => result.current.to(187));
    expect(result.current.offsetOf(1)).toBe(100 + GAP);
  });

  it("scrolls faster the deeper into the edge the hand goes", () => {
    const shallow = stage();
    const deep = stage();
    for (const [world, x] of [
      [shallow, VIEW - 50],
      [deep, VIEW - 5],
    ] as const) {
      const { result } = renderHook(() =>
        useMoveAlongStrip({
          canvas: { current: world.scroller },
          list: { current: world.list },
          gap: GAP,
          onDrop: vi.fn(),
        }),
      );
      act(() => result.current.start(0, 50));
      act(() => result.current.to(x));
      act(() => vi.advanceTimersByTime(160));
      act(() => result.current.end());
    }
    expect(shallow.scrolled()).toBeGreaterThan(0);
    expect(deep.scrolled()).toBeGreaterThan(shallow.scrolled() * 3);
  });
});
