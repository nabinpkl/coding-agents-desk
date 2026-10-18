// The scroll clutch and the puck that engages it: what stays local, what reaches the Mac
// as a wheel, and what a tap on the puck means.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import { TileViewport } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import { tileViewportHarness } from "@/features/desktop-viewer/tile-viewport/tileViewportHarness";

describe("TileViewport scroll clutch", () => {
  const { activatePuckWithKeyboard, animationFrames, pointer, renderPointerSurface, scaleOf } = tileViewportHarness();

  it("uses the puck to clutch one finger into free-axis scroll without moving the cursor", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface(
      (input) => {
        inputs.push(input);
        return true;
      },
      { width: 800, height: 500, cursor: { x: 400, y: 250 } },
    );
    const puck = activatePuckWithKeyboard();
    const overlay = screen.getByTestId("client-cursor-overlay");
    const parked = overlay.style.transform;

    expect(puck).toHaveAttribute("aria-pressed", "true");
    pointer(surface, "pointerdown", 1, 20, 20);
    // The travel that crosses the slop opens the scroll and is not itself sent, as UIKit's pan
    // does not send it; the move after it is the first scroll.
    pointer(surface, "pointermove", 1, 45, 35);
    pointer(surface, "pointermove", 1, 70, 50);
    pointer(surface, "pointerup", 1, 70, 50);

    expect(inputs.some((input) => input.type === "pointer-move")).toBe(false);
    expect(inputs.some((input) => input.type === "click")).toBe(false);
    expect(inputs.filter((input) => input.type === "scroll").map((input) => input.phase)).toEqual(["began", "ended"]);
    const began = inputs.find((input) => input.type === "scroll" && input.phase === "began");
    expect(began).toMatchObject({ type: "scroll" });
    if (began?.type === "scroll") {
      expect(began.dx).toBeGreaterThan(0);
      expect(began.dy).toBeGreaterThan(0);
    }
    expect(overlay.style.transform).toBe(parked);
  });

  it("keeps two fingers exclusively local while the scroll clutch is engaged", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    activatePuckWithKeyboard();
    const transformed = screen.getByTestId("content").parentElement!;

    pointer(surface, "pointerdown", 1, 200, 250);
    pointer(surface, "pointerdown", 2, 600, 250);
    pointer(surface, "pointermove", 2, 700, 250);
    pointer(surface, "pointermove", 1, 250, 280);
    pointer(surface, "pointerup", 2, 700, 250);
    pointer(surface, "pointerup", 1, 250, 280);

    expect(scaleOf(transformed.style.transform)).toBeGreaterThan(1);
    expect(inputs).toEqual([]);
  });

  it("emits native-style momentum and aborts it when a new scroll touch begins", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    activatePuckWithKeyboard();

    pointer(surface, "pointerdown", 1, 20, 20);
    pointer(surface, "pointermove", 1, 50, 20);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointermove", 1, 90, 20);
    act(() => animationFrames.shift()?.(performance.now() + 32));
    pointer(surface, "pointerup", 1, 90, 20);
    act(() => animationFrames.shift()?.(performance.now() + 48));

    expect(inputs.some((input) => input.type === "scroll" && input.phase === "momentumBegan")).toBe(true);
    pointer(surface, "pointerdown", 2, 100, 20);
    expect(inputs.at(-1)).toEqual({
      type: "scroll",
      dx: 0,
      dy: 0,
      phase: "momentumEnded",
    });
    pointer(surface, "pointercancel", 2, 100, 20);
  });

  it("sends the mouse wheel to the Mac while the clutch is engaged, and ends it on silence", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    activatePuckWithKeyboard();

    surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 0, deltaY: 30 }));
    surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 0, deltaY: 30 }));

    // The wheel does not wait for an animation frame, and its delta goes out unaccelerated:
    // macOS already applied its own curve before Chrome reported it.
    expect(inputs).toEqual([
      { type: "scroll", dx: -0, dy: -30, phase: "began" },
      { type: "scroll", dx: -0, dy: -30, phase: "changed" },
    ]);

    // A wheel has no lift, so the end comes from the quiet after it.
    act(() => vi.advanceTimersByTime(200));
    expect(inputs.at(-1)).toEqual({ type: "scroll", dx: 0, dy: 0, phase: "ended" });
  });

  it("keeps the wheel local when the clutch is off or the gesture is a pinch", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    const transformed = screen.getByTestId("content").parentElement!;

    surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 30 }));
    expect(inputs).toEqual([]);

    activatePuckWithKeyboard();
    surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100, ctrlKey: true }));

    expect(inputs).toEqual([]);
    expect(scaleOf(transformed.style.transform)).toBeGreaterThan(1);
  });

  it("delays a physical puck tap for double-tap zoom arbitration", () => {
    vi.useFakeTimers();
    const surface = renderPointerSurface(() => true, { width: 800, height: 500, cursor: { x: 400, y: 250 } });
    const puck = screen.getByTestId("pointer-scroll-puck");
    const transformed = screen.getByTestId("content").parentElement!;

    pointer(puck, "pointerdown", 10, 40, 40);
    pointer(puck, "pointerup", 10, 40, 40);
    expect(puck).toHaveAttribute("aria-pressed", "false");
    act(() => vi.advanceTimersByTime(299));
    expect(puck).toHaveAttribute("aria-pressed", "false");

    pointer(puck, "pointerdown", 11, 40, 40);
    pointer(puck, "pointerup", 11, 40, 40);
    expect(scaleOf(transformed.style.transform)).toBeCloseTo(2.5);
    expect(puck).toHaveAttribute("aria-pressed", "false");
    act(() => vi.runOnlyPendingTimers());
    expect(puck).toHaveAttribute("aria-pressed", "false");
    expect(surface.contains(puck)).toBe(true);
  });

  it("engages the scroll clutch after an unpaired physical tap", () => {
    vi.useFakeTimers();
    renderPointerSurface(() => true);
    const puck = screen.getByTestId("pointer-scroll-puck");

    pointer(puck, "pointerdown", 10, 40, 40);
    pointer(puck, "pointerup", 10, 40, 40);
    act(() => vi.advanceTimersByTime(300));

    expect(puck).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the puck deaf to the tile after the keyboard has come and gone", () => {
    vi.useFakeTimers();
    const inputs: DesktopPointerInput[] = [];
    const beforeRemoteClick = vi.fn(() => "focus-1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const surface = (presented: boolean) => (
      <TileViewport
        pointerMode
        keyboardPresented={presented}
        onBeforeRemoteClick={beforeRemoteClick}
        sendPointerInput={(input) => {
          inputs.push(input);
          return true;
        }}
      >
        <div data-testid="content" />
      </TileViewport>
    );
    const { rerender } = render(surface(false));
    // Present the keyboard and dismiss it: the puck must come back wired to its
    // own gesture arbitration, not to the tile's tap-to-click-and-arm path.
    rerender(surface(true));
    rerender(surface(false));

    const puck = screen.getByTestId("pointer-scroll-puck");
    pointer(puck, "pointerdown", 10, 40, 40);
    pointer(puck, "pointerup", 10, 40, 40);
    act(() => vi.advanceTimersByTime(300));

    expect(beforeRemoteClick).not.toHaveBeenCalled();
    expect(inputs).toEqual([]);
    expect(puck).toHaveAttribute("aria-pressed", "true");
  });

  it("drags and clamps the puck without toggling the clutch or driving the Mac", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    const puck = screen.getByTestId("pointer-scroll-puck");
    act(() => window.dispatchEvent(new Event("resize")));

    pointer(puck, "pointerdown", 10, 100, 100);
    pointer(puck, "pointermove", 10, -1_000, -1_000);
    pointer(puck, "pointerup", 10, -1_000, -1_000);

    expect(puck.style.right).toBe("744px");
    expect(puck.style.bottom).toBe("max(444px, var(--desktop-chrome-clearance, 0px))");
    expect(puck).toHaveAttribute("aria-pressed", "false");
    expect(inputs).toEqual([]);
    expect(surface.contains(puck)).toBe(true);
  });
});
