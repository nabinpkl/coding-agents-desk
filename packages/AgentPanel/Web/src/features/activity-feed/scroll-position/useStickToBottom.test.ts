import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStickToBottom } from "@/features/activity-feed/scroll-position/useStickToBottom";

// The previously-racy follow logic is now a deterministic machine driven by a
// ResizeObserver callback and scrollTop direction. We mock the observer and
// rAF so every transition can be stepped explicitly.

let roCallback: (() => void) | null = null;
class MockResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb;
  }
  observe() {}
  disconnect() {}
}

let rafQueue: FrameRequestCallback[] = [];
function flushRaf() {
  const q = rafQueue;
  rafQueue = [];
  q.forEach((cb) => cb(0));
}

type MockScrollEl = HTMLElement & {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function makeScrollEl(scrollHeight = 1000, clientHeight = 300) {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    addEventListener(type: string, fn: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    clientWidth: 600,
    removeEventListener(type: string, fn: EventListener) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, event: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(event as Event);
    },
  } as unknown as MockScrollEl & { dispatch(type: string, event: unknown): void };
}

/** Two-finger flick. Negative deltaY is towards earlier content. */
function wheel(el: ReturnType<typeof makeScrollEl>, deltaY: number) {
  el.dispatch("wheel", { deltaY });
}

/** A press on the native scrollbar, which lands on the scroller itself at its right edge. */
function grabScrollbar(el: ReturnType<typeof makeScrollEl>) {
  el.dispatch("pointerdown", { target: el, offsetX: el.clientWidth + 4 });
}

beforeEach(() => {
  roCallback = null;
  rafQueue = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return 0;
  });
});

function setup(scrollEl = makeScrollEl()) {
  const scrollRef = { current: scrollEl };
  const sizedRef = { current: {} as HTMLElement };
  const view = renderHook(() =>
    useStickToBottom(
      scrollRef as React.RefObject<HTMLElement | null>,
      sizedRef as React.RefObject<HTMLElement | null>,
      true,
    ),
  );
  return { view, scrollEl };
}

describe("useStickToBottom", () => {
  it("starts following and pins to the measured bottom on resize", () => {
    const { view, scrollEl } = setup();
    expect(view.result.current.following).toBe(true);
    act(() => roCallback!()); // content measured in
    expect(scrollEl.scrollTop).toBe(scrollEl.scrollHeight);
  });

  it("keeps pinning as measured height grows (no estimate dependence)", () => {
    const { scrollEl } = setup();
    act(() => roCallback!());
    expect(scrollEl.scrollTop).toBe(1000);
    scrollEl.scrollHeight = 2500; // rows remeasured taller
    act(() => roCallback!());
    expect(scrollEl.scrollTop).toBe(2500);
  });

  it("does not detach when the content shrinks and clamps scrollTop while pinned", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    // At the bottom, content momentarily drops in height (the live tail hands
    // off to durable rows before the next tail grows). The browser clamps
    // scrollTop down to the new bottom -- a decrease, but NOT a user gesture;
    // following must survive it, or streaming would detach on every handoff.
    scrollEl.scrollHeight = 600;
    scrollEl.scrollTop = 300; // clamped to the new bottom (600 - 300)
    act(() => view.result.current.onScroll());
    expect(view.result.current.following).toBe(true);
    expect(scrollEl.scrollTop).toBe(300);
  });

  // The delivered scroll event carries a position from the layout that clamped
  // it and a scrollHeight from the layout in force when it is handled. Streaming
  // makes those differ constantly: the tail hands off (shorter, so scrollTop is
  // clamped down) and the next tail grows the list back before the event runs.
  // Judged on distance-from-end alone that reads as a pull far away from a tall
  // list, which used to raise "Scroll down" over a viewport sitting on the last
  // row.
  it("does not detach when a clamp is delivered after the content grew back", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    scrollEl.scrollTop = 300; // clamped when the list was briefly 600 tall
    scrollEl.scrollHeight = 1400; // ...and the next tail is already growing
    act(() => view.result.current.onScroll());
    expect(view.result.current.following).toBe(true);
  });

  it("a flick DOWNWARD does not authorize the clamp that follows it", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => wheel(scrollEl, 120)); // towards the tail: moves nothing, still fires
    scrollEl.scrollTop = 300;
    scrollEl.scrollHeight = 1400;
    act(() => view.result.current.onScroll());
    expect(view.result.current.following).toBe(true);
  });

  it("detaches on an upward flick even while the content is still growing", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => wheel(scrollEl, -120));
    scrollEl.scrollTop = 500;
    scrollEl.scrollHeight = 1400; // the stream did not stop for the gesture
    act(() => view.result.current.onScroll());
    expect(view.result.current.following).toBe(false);
  });

  it("detaches on an upward key while the content is still growing", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    });
    scrollEl.scrollTop = 500;
    scrollEl.scrollHeight = 1400;
    act(() => view.result.current.onScroll());
    expect(view.result.current.following).toBe(false);
  });

  it("a stale flick does not authorize a later clamp", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { view, scrollEl } = setup();
      act(() => {
        roCallback!();
        flushRaf();
      });
      act(() => wheel(scrollEl, -120));
      vi.advanceTimersByTime(1000);
      scrollEl.scrollTop = 300;
      scrollEl.scrollHeight = 1400;
      act(() => view.result.current.onScroll());
      expect(view.result.current.following).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches on a drag of the scrollbar, which fires no wheel, touch or key", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => grabScrollbar(scrollEl));
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(false);
  });

  it("a press on a row, not the scrollbar, does not authorize a decrease", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => scrollEl.dispatch("pointerdown", { target: {}, offsetX: 590 }));
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(true);
  });

  it("a released scrollbar no longer authorizes one", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => grabScrollbar(scrollEl));
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(true);
  });

  // Measured at the end of every assistant message: the live row hands off to its durable row, the
  // content dips and comes back to the SAME height inside one frame, and the browser clamped
  // scrollTop on the way down. The ResizeObserver sees no change, so this scroll event is the only
  // thing that can put the viewport back.
  it("re-pins a following viewport left short of the end with the height unchanged", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => {
      scrollEl.scrollTop = 621; // 79px short of the end of a list still 1000 tall
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(true);
    expect(scrollEl.scrollTop).toBe(1000);
  });

  it("does not re-pin while browsing when content grows", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => wheel(scrollEl, -120));
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    scrollEl.scrollHeight = 2000; // growth arrives while browsing
    act(() => roCallback!());
    expect(scrollEl.scrollTop).toBe(400); // left alone
  });

  it("re-attaches when the user scrolls back to the end", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => wheel(scrollEl, -120));
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(false);
    act(() => wheel(scrollEl, 120));
    act(() => {
      scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(true);
  });

  // Measured on a restored transcript: it opens at the bottom, the restore pauses the follower and
  // jumps up, and the scroll event of the opening position arrives after the pause. Read as "back at
  // the end" it re-attached, and the reader's first nudge down then snapped to the tail.
  it("a scroll event at the end that no input caused does not re-attach", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => view.result.current.pause());
    act(() => view.result.current.onScroll()); // still at the bottom it opened on
    expect(view.result.current.following).toBe(false);
    act(() => {
      scrollEl.scrollTop = 600; // the restore's jump up, then the reader's nudge down
      view.result.current.onScroll();
    });
    act(() => wheel(scrollEl, 120));
    act(() => {
      scrollEl.scrollTop = 640;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(false);
    expect(scrollEl.scrollTop).toBe(640);
  });

  it("a downward wheel at the end re-attaches, though it moves nothing and fires no scroll", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => view.result.current.pause());
    scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    act(() => wheel(scrollEl, 120));
    expect(view.result.current.following).toBe(true);
  });

  it("a stale downward input does not re-attach a later arrival at the end", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { view, scrollEl } = setup();
      act(() => {
        roCallback!();
        flushRaf();
      });
      act(() => view.result.current.pause());
      scrollEl.scrollTop = 300;
      act(() => wheel(scrollEl, 120));
      vi.advanceTimersByTime(1500);
      act(() => {
        scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
        view.result.current.onScroll();
      });
      expect(view.result.current.following).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bottom-snap never flips to browsing", () => {
    const { view } = setup();
    act(() => roCallback!()); // snap increases scrollTop to the bottom
    act(() => view.result.current.onScroll()); // the scroll event it triggers
    expect(view.result.current.following).toBe(true);
  });

  it("pause() detaches; scrollToBottom() re-follows and pins", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => view.result.current.pause());
    expect(view.result.current.following).toBe(false);
    scrollEl.scrollHeight = 1800;
    act(() => view.result.current.scrollToBottom());
    expect(view.result.current.following).toBe(true);
    expect(scrollEl.scrollTop).toBe(1800);
  });
});
