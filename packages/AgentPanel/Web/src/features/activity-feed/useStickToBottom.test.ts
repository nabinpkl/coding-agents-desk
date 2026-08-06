import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStickToBottom } from "./useStickToBottom";

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

function makeScrollEl(scrollHeight = 1000, clientHeight = 300) {
  return { scrollTop: 0, scrollHeight, clientHeight } as unknown as HTMLElement & {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };
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
    const { view, scrollEl } = setup();
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

it("detaches when the user scrolls up (scrollTop decreases)", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(false);
  });

  it("does not re-pin while browsing when content grows", () => {
    const { view, scrollEl } = setup();
    act(() => {
      roCallback!();
      flushRaf();
    });
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
    act(() => {
      scrollEl.scrollTop = 400;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(false);
    act(() => {
      scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
      view.result.current.onScroll();
    });
    expect(view.result.current.following).toBe(true);
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
