// One finger on the tile: where the pointer goes, when a hold becomes a held button, and
// what ends one.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import { TileViewport, type ViewportGestureTelemetry } from "@/features/desktop-viewer/TileViewport";
import { tileViewportHarness } from "@/features/desktop-viewer/tileViewportHarness";

describe("TileViewport pointer mode", () => {
  const {
    activatePuckWithKeyboard,
    animationFrames,
    frameObservers,
    pointer,
    renderPointerSurface,
    scaleOf,
  } = tileViewportHarness();

  it("moves the existing pointer relatively and does not turn a drag into a click", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 10, 10);
    pointer(surface, "pointermove", 1, 18, 14);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 1, 18, 14);

    const move = inputs.find((input) => input.type === "pointer-move");
    expect(move).toMatchObject({ type: "pointer-move" });
    if (move?.type === "pointer-move") {
      expect(move.revision).toBe(1);
      expect(move.dx).toBeGreaterThan(0);
      expect(move.dy).toBeGreaterThan(0);
    }
    expect(inputs.some((input) => input.type === "click")).toBe(false);
  });

  it("clicks at the parked cursor for a tap", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    pointer(surface, "pointerup", 1, 80, 50);

    expect(inputs).toEqual([{ type: "click", button: "left" }]);
  });

  it("holds a still finger into a pressed button, carries it, and drops it where it is lifted", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    act(() => vi.advanceTimersByTime(600));
    expect(inputs).toEqual([{ type: "mouse-down", button: "left" }]);

    pointer(surface, "pointermove", 1, 140, 90);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    expect(inputs.some((input) => input.type === "pointer-move")).toBe(true);

    pointer(surface, "pointerup", 1, 140, 90);
    expect(inputs.at(-1)).toEqual({ type: "mouse-up", button: "left" });
    // The lift ends a drag, so it must not also be read as a tap.
    expect(inputs.some((input) => input.type === "click")).toBe(false);
  });

  it("shows the hold priming as a ring, and takes it back on every path that ends the hold", () => {
    vi.useFakeTimers();
    const surface = renderPointerSurface(() => true);
    const ring = () => screen.getByTestId("client-drag-priming");

    // Nothing under an ordinary tap: the ring waits out the length of one first.
    pointer(surface, "pointerdown", 1, 80, 50);
    act(() => vi.advanceTimersByTime(140));
    expect(ring().hidden).toBe(true);
    act(() => vi.advanceTimersByTime(20));
    expect(ring().hidden).toBe(false);

    // The held state takes over the moment the drag arms, so the ring is not left doubling it.
    act(() => vi.advanceTimersByTime(600));
    expect(ring().hidden).toBe(true);
    expect(screen.getByTestId("client-drag-halo").hidden).toBe(false);
    pointer(surface, "pointerup", 1, 80, 50);

    // A finger that travels cancels the hold, and the ring goes with it.
    pointer(surface, "pointerdown", 2, 80, 50);
    act(() => vi.advanceTimersByTime(200));
    expect(ring().hidden).toBe(false);
    pointer(surface, "pointermove", 2, 140, 90);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    expect(ring().hidden).toBe(true);
    pointer(surface, "pointerup", 2, 140, 90);

    // So does a second finger, and a cancelled pointer.
    pointer(surface, "pointerdown", 3, 80, 50);
    act(() => vi.advanceTimersByTime(200));
    expect(ring().hidden).toBe(false);
    pointer(surface, "pointerdown", 4, 200, 120);
    expect(ring().hidden).toBe(true);
    pointer(surface, "pointerup", 3, 80, 50);
    pointer(surface, "pointerup", 4, 200, 120);

    pointer(surface, "pointerdown", 5, 80, 50);
    act(() => vi.advanceTimersByTime(200));
    expect(ring().hidden).toBe(false);
    pointer(surface, "pointercancel", 5, 80, 50);
    expect(ring().hidden).toBe(true);
  });

  it("presses a mouse button on the press and shows it held for as long as it is", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    }, { width: 800, height: 500, cursor: { x: 400, y: 250 } }, undefined, true);
    const halo = () => screen.getByTestId("client-drag-halo");

    // A mouse holds its own button. Nothing to wait out, so no ring and no hold: the press is the
    // press, and the drag is whatever movement follows it.
    pointer(surface, "pointerdown", 1, 100, 100, "mouse");
    expect(inputs.map((input) => input.type)).toEqual(["pointer-warp", "mouse-down"]);
    expect(halo().hidden).toBe(false);
    expect(screen.getByTestId("client-drag-priming").hidden).toBe(true);

    pointer(surface, "pointermove", 1, 200, 160, "mouse");
    expect(halo().hidden).toBe(false);
    pointer(surface, "pointerup", 1, 200, 160, "mouse");
    expect(inputs.at(-1)).toEqual({ type: "mouse-up", button: "left" });
    expect(halo().hidden).toBe(true);
    // Press and release is a click on the Mac already; a second synthetic one would double it.
    expect(inputs.some((input) => input.type === "click")).toBe(false);
  });

  it("lets go of a mouse button when the viewport goes away mid-drag", () => {
    const inputs: DesktopPointerInput[] = [];
    const view = render(
      <TileViewport
        pointerMode
        absolutePointer
        sendPointerInput={(input) => { inputs.push(input); return true; }}
        sourceWidth={800}
        sourceHeight={500}
        initialCursor={{ x: 400, y: 250 }}
      >
        <div data-testid="content" />
      </TileViewport>,
    );
    const surface = screen.getByTestId("content").parentElement!.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });
    pointer(surface, "pointerdown", 1, 100, 100, "mouse");
    expect(inputs.some((input) => input.type === "mouse-down")).toBe(true);

    // Unmounting mid-drag otherwise leaves the far Mac holding a button nobody is pressing.
    view.unmount();
    expect(inputs.at(-1)).toEqual({ type: "mouse-up", button: "left" });
  });

  it("does not press when the finger travels before the hold completes", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    pointer(surface, "pointermove", 1, 120, 70);
    act(() => vi.advanceTimersByTime(600));
    pointer(surface, "pointerup", 1, 120, 70);

    expect(inputs.some((input) => input.type === "mouse-down")).toBe(false);
    expect(inputs.some((input) => input.type === "mouse-up")).toBe(false);
  });

  it("lets go of a held button when the pointer is cancelled", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    act(() => vi.advanceTimersByTime(600));
    pointer(surface, "pointercancel", 1, 80, 50);

    expect(inputs.at(-1)).toEqual({ type: "mouse-up", button: "left" });
  });

  it("lets go of a held button when a second finger arrives", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    act(() => vi.advanceTimersByTime(600));
    pointer(surface, "pointerdown", 2, 300, 200);

    expect(inputs.at(-1)).toEqual({ type: "mouse-up", button: "left" });
  });

  it("dismisses and consumes the entire first pointer sequence while typing", () => {
    const inputs: DesktopPointerInput[] = [];
    const consume = vi.fn(() => true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    render(
      <TileViewport
        pointerMode
        keyboardPresented
        onPointerGestureStart={consume}
        sendPointerInput={(input) => { inputs.push(input); return true; }}
      >
        <div data-testid="consumed-content" />
      </TileViewport>,
    );
    const surface = screen.getByTestId("consumed-content").parentElement!.parentElement!;
    pointer(surface, "pointerdown", 1, 10, 10);
    pointer(surface, "pointermove", 1, 90, 80);
    pointer(surface, "pointerup", 1, 90, 80);
    expect(consume).toHaveBeenCalledOnce();
    expect(inputs).toEqual([]);
    expect(screen.getByTestId("pointer-scroll-puck")).not.toBeVisible();
  });
});
