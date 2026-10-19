import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapBackWitness, type SnapFacts } from "@/features/activity-feed/scroll-position/useSnapBackWitness";
import { useStickToBottom } from "@/features/activity-feed/scroll-position/useStickToBottom";
import { reportFeedSnapBack } from "@/features/telemetry/feedSnapBack";

vi.mock("@/features/telemetry/feedSnapBack", () => ({ reportFeedSnapBack: vi.fn() }));

const report = vi.mocked(reportFeedSnapBack);
let now = 10_000;

const facts: SnapFacts = {
  cause: "resize",
  upPx: 120,
  enforcing: false,
  scrollbarHeld: false,
  scrollHeight: 2000,
  clientHeight: 500,
  intentAt: Number.NEGATIVE_INFINITY,
};

/** A transcript with one row in it, in the document so the window sees wheels over it. */
function transcript() {
  const scroller = document.createElement("div");
  const row = document.createElement("p");
  scroller.append(row);
  document.body.append(scroller);
  return { scroller, row };
}

function wheelOver(target: Element, deltaY: number): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  now = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  report.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("useSnapBackWitness", () => {
  it("reports a snap after an upward wheel the follower never received", () => {
    const { scroller, row } = transcript();
    const { result } = renderHook(() => useSnapBackWitness(scroller, "claude:s1"));
    wheelOver(row, -80);
    now += 400;
    result.current.snapped(facts);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({
      session: "claude:s1",
      cause: "resize",
      upPx: 120,
      wheelAgoMs: 400,
      intentAgoMs: -1,
      hookSawWheel: false,
      heldBack: 0,
    });
  });

  it("says when the follower did receive that wheel", () => {
    const { scroller, row } = transcript();
    const { result } = renderHook(() => useSnapBackWitness(scroller, "claude:s1"));
    const event = wheelOver(row, -80);
    result.current.sawWheel(event);
    // The momentum that ends a trackpad flick: the window keeps nothing of it, and nor may the follower.
    result.current.sawWheel(wheelOver(row, 0));
    result.current.snapped({ ...facts, intentAt: now - 300 });
    expect(report.mock.calls[0]![0]).toMatchObject({ hookSawWheel: true, intentAgoMs: 300 });
  });

  it("ignores snaps with no recent upward wheel over this transcript", () => {
    const { scroller, row } = transcript();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    const { result } = renderHook(() => useSnapBackWitness(scroller, "claude:s1"));
    result.current.snapped(facts);
    wheelOver(row, 80);
    result.current.snapped(facts);
    wheelOver(elsewhere, -80);
    result.current.snapped(facts);
    wheelOver(row, -80);
    now += 1500;
    result.current.snapped(facts);
    expect(report).not.toHaveBeenCalled();
  });

  it("sends one report per two seconds and counts the snaps it held back", () => {
    const { scroller, row } = transcript();
    const { result } = renderHook(() => useSnapBackWitness(scroller, "claude:s1"));
    wheelOver(row, -80);
    result.current.snapped(facts);
    now += 100;
    result.current.snapped(facts);
    result.current.snapped(facts);
    now += 2000;
    wheelOver(row, -80);
    result.current.snapped(facts);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toMatchObject({ heldBack: 2 });
  });
});

describe("useStickToBottom's snap-back report", () => {
  let grew = () => {};
  beforeEach(() => {
    grew = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          grew = () => callback([{}]);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });

  it("reports the scroll it read as layout after the reader wheeled up", () => {
    const { scroller, row } = transcript();
    let top = 1500;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = Math.min(value, 1500)) },
    });
    const { result } = renderHook(() => useStickToBottom(scroller, document.createElement("div"), "claude:s1"));
    act(() => result.current.onScroll());
    wheelOver(row, -80);
    // Past the follower's 250ms window: the scroll that follows reads as layout and is snapped.
    now += 400;
    top = 1300;
    act(() => result.current.onScroll());
    expect(top).toBe(1500);
    expect(result.current.following).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({
      session: "claude:s1",
      cause: "scroll",
      upPx: 200,
      wheelAgoMs: 400,
      intentAgoMs: 400,
      hookSawWheel: true,
    });
  });

  it("does not report the reader asking for the end", () => {
    const { scroller, row } = transcript();
    let top = 1000;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = Math.min(value, 1500)) },
    });
    const { result } = renderHook(() => useStickToBottom(scroller, document.createElement("div"), "claude:s1"));
    wheelOver(row, -80);
    act(() => result.current.scrollToBottom());
    expect(top).toBe(1500);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports growth that pulls back a reader who rose, and not growth followed at the end", () => {
    const { scroller, row } = transcript();
    let height = 2000;
    let top = 1500;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = Math.min(value, height - 500)) },
    });
    const { result } = renderHook(() => useStickToBottom(scroller, document.createElement("div"), "claude:s1"));
    act(() => result.current.onScroll());
    wheelOver(row, -80);
    now += 400;
    // A streaming row grows while the viewport sits where the follower put it: ordinary following.
    height = 2300;
    act(() => grew());
    expect(top).toBe(1800);
    expect(report).not.toHaveBeenCalled();
    // The viewport has risen 150px and its scroll event has not arrived when the content grows.
    top = 1650;
    height = 2400;
    act(() => grew());
    expect(top).toBe(1900);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({ cause: "resize", upPx: 150, hookSawWheel: true });
  });
});
