// The trackpad deck: the pad and the strip doing what the Swift client's did, on the shared
// pointer the picture also draws.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import { createPointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { TileViewport } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import { TrackpadDeck } from "@/features/desktop-viewer/trackpad/TrackpadDeck";

const frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames.length = 0;
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runFrames(at: number) {
  const due = frames.splice(0);
  act(() => {
    for (const frame of due) frame(at);
  });
}

function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerId: number,
  clientX: number,
  clientY: number,
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  act(() => {
    target.dispatchEvent(event);
  });
}

function renderDeck(beforeClick?: () => string | undefined) {
  const sent: DesktopPointerInput[] = [];
  const input = createPointerInputSession((next) => {
    sent.push(next);
    return true;
  });
  input.cursor.reset({ width: 1000, height: 600 }, { x: 500, y: 300 });
  const view = render(<TrackpadDeck input={input} height={240} beforeClick={beforeClick} />);
  const pad = screen.getByTestId("trackpad-pad");
  Object.defineProperties(pad, {
    clientWidth: { configurable: true, value: 300 },
    clientHeight: { configurable: true, value: 200 },
  });
  return { sent, input, view, pad, strip: screen.getByTestId("trackpad-scroll-strip") };
}

describe("TrackpadDeck pad", () => {
  it("clicks where the pointer is for a tap, asking the keyboard first", () => {
    const beforeClick = vi.fn(() => "focus-7");
    const { sent, pad } = renderDeck(beforeClick);
    pointer(pad, "pointerdown", 1, 100, 100);
    pointer(pad, "pointerup", 1, 101, 100);
    expect(sent).toEqual([{ type: "click", button: "left", focusRequestId: "focus-7" }]);
  });

  it("moves the shared pointer, numbered and accelerated, and does not click after a move", () => {
    const { sent, input, pad } = renderDeck();
    pointer(pad, "pointerdown", 1, 100, 100);
    pointer(pad, "pointermove", 1, 110, 100);
    runFrames(performance.now() + 20);
    pointer(pad, "pointerup", 1, 110, 100);
    const move = sent.find((next) => next.type === "pointer-move");
    expect(move).toMatchObject({ type: "pointer-move", revision: 1, dy: 0 });
    // Accelerated: more than the 10px the finger travelled.
    expect(move?.type === "pointer-move" && move.dx).toBeGreaterThan(10);
    expect(input.cursor.position.x).toBeGreaterThan(510);
    expect(sent.some((next) => next.type === "click")).toBe(false);
  });

  it("holds the button after 250ms still, carries it 1:1, and drops it on lift without a click", () => {
    const { sent, pad } = renderDeck();
    pointer(pad, "pointerdown", 1, 100, 100);
    act(() => vi.advanceTimersByTime(249));
    expect(sent).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(sent).toEqual([{ type: "mouse-down", button: "left" }]);
    expect(pad).toHaveAttribute("data-held");

    pointer(pad, "pointermove", 1, 130, 110);
    expect(sent.at(-1)).toEqual({ type: "pointer-move", revision: 1, dx: 30, dy: 10 });

    pointer(pad, "pointerup", 1, 130, 110);
    expect(sent.at(-1)).toEqual({ type: "mouse-up", button: "left" });
    expect(sent.some((next) => next.type === "click")).toBe(false);
    expect(pad).not.toHaveAttribute("data-held");
  });

  it("does not hold a finger that moved first", () => {
    const { sent, pad } = renderDeck();
    pointer(pad, "pointerdown", 1, 100, 100);
    pointer(pad, "pointermove", 1, 120, 100);
    act(() => vi.advanceTimersByTime(600));
    expect(sent.some((next) => next.type === "mouse-down")).toBe(false);
    pointer(pad, "pointerup", 1, 120, 100);
  });

  it("lets go when a second finger lands, and when the deck goes away mid-drag", () => {
    const first = renderDeck();
    pointer(first.pad, "pointerdown", 1, 100, 100);
    act(() => vi.advanceTimersByTime(250));
    pointer(first.pad, "pointerdown", 2, 200, 100);
    expect(first.sent.at(-1)).toEqual({ type: "mouse-up", button: "left" });
    pointer(first.pad, "pointerup", 2, 200, 100);
    pointer(first.pad, "pointerup", 1, 100, 100);
    expect(first.sent.some((next) => next.type === "click")).toBe(false);
    first.view.unmount();

    const second = renderDeck();
    pointer(second.pad, "pointerdown", 1, 100, 100);
    act(() => vi.advanceTimersByTime(250));
    second.view.unmount();
    expect(second.sent.at(-1)).toEqual({ type: "mouse-up", button: "left" });
  });

  it("right-clicks from the button", () => {
    const { sent } = renderDeck();
    fireEvent.click(screen.getByRole("button", { name: "Right click" }));
    expect(sent).toEqual([{ type: "click", button: "right" }]);
  });
});

describe("TrackpadDeck scroll strip", () => {
  it("starts at touch-down, commits to the vertical axis, and ends the phase on lift", () => {
    const { sent, strip } = renderDeck();
    pointer(strip, "pointerdown", 1, 30, 100);
    pointer(strip, "pointermove", 1, 33, 113);
    pointer(strip, "pointermove", 1, 35, 125);
    pointer(strip, "pointerup", 1, 35, 125);
    const scrolls = sent.filter((next) => next.type === "scroll");
    expect(scrolls.map((next) => next.phase)).toEqual(["began", "changed", "ended"]);
    for (const next of scrolls) expect(next.dx).toBe(0);
    expect(scrolls[0]!.dy).toBeGreaterThan(0);
  });

  it("keeps scrolling when the finger leaves the strip, since the gesture began on it", () => {
    const { sent, strip } = renderDeck();
    pointer(strip, "pointerdown", 1, 30, 100);
    pointer(strip, "pointermove", 1, 30, 200);
    pointer(strip, "pointermove", 1, -400, 300);
    expect(sent.filter((next) => next.type === "scroll").length).toBe(2);
  });

  it("coasts after a throw, and a new touch on the strip ends the coast", () => {
    const { sent, strip } = renderDeck();
    pointer(strip, "pointerdown", 1, 30, 100);
    act(() => vi.advanceTimersByTime(10));
    pointer(strip, "pointermove", 1, 30, 140);
    act(() => vi.advanceTimersByTime(10));
    pointer(strip, "pointermove", 1, 30, 180);
    pointer(strip, "pointerup", 1, 30, 180);
    runFrames(performance.now() + 16);
    expect(sent.at(-1)).toMatchObject({ type: "scroll", phase: "momentumBegan", dx: 0 });
    pointer(strip, "pointerdown", 2, 30, 100);
    expect(sent.at(-1)).toEqual({ type: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });
  });
});

describe("TrackpadDeck with the picture", () => {
  it("moves the cursor the picture draws, because both drive one session", () => {
    const sent: DesktopPointerInput[] = [];
    const input = createPointerInputSession((next) => {
      sent.push(next);
      return true;
    });
    render(
      <>
        <TileViewport pointerMode input={input} sourceWidth={800} sourceHeight={500} initialCursor={{ x: 100, y: 100 }}>
          <div data-testid="content" />
        </TileViewport>
        <TrackpadDeck input={input} height={240} />
      </>,
    );
    const surface = screen.getByTestId("content").parentElement!.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });
    const overlay = screen.getByTestId("client-cursor-overlay");
    const pad = screen.getByTestId("trackpad-pad");
    pointer(pad, "pointerdown", 1, 100, 100);
    act(() => vi.advanceTimersByTime(250));
    pointer(pad, "pointermove", 1, 150, 100);
    expect(overlay.style.transform).toBe("translate3d(150px, 100px, 0)");
    pointer(pad, "pointerup", 1, 150, 100);
  });
});

describe("TrackpadDeck tuning", () => {
  afterEach(async () => {
    const { useGestureTuning } = await import("@/features/desktop-viewer/pointer-input/gestureTuning");
    useGestureTuning.getState().resetTuning();
  });

  it("scales what the pad sends by the pointer speed set in the panel", () => {
    const { sent, pad } = renderDeck();
    fireEvent.click(screen.getByRole("button", { name: "Tuning" }));
    fireEvent.change(screen.getByLabelText("Pointer speed"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("gesture-tuning")).not.toBeInTheDocument();

    pointer(pad, "pointerdown", 1, 100, 100);
    act(() => vi.advanceTimersByTime(250));
    pointer(pad, "pointermove", 1, 110, 100);
    // Held drags are 1:1 times the tuning: 10px at 2x is 20.
    expect(sent.at(-1)).toEqual({ type: "pointer-move", revision: 1, dx: 20, dy: 0 });
    pointer(pad, "pointerup", 1, 110, 100);
  });

  it("flips the strip's direction with natural scrolling", () => {
    const { sent, strip } = renderDeck();
    fireEvent.click(screen.getByRole("button", { name: "Tuning" }));
    fireEvent.click(screen.getByLabelText("Natural scrolling"));
    pointer(strip, "pointerdown", 1, 30, 100);
    pointer(strip, "pointermove", 1, 30, 120);
    expect(sent.find((next) => next.type === "scroll")).toMatchObject({ dx: 0, phase: "began" });
    const began = sent.find((next) => next.type === "scroll");
    expect(began?.type === "scroll" && began.dy).toBeLessThan(0);
  });
});
