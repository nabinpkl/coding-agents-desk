// Zoom, pan, and the strip the keyboard leaves: what the viewer chose, what the box being
// shortened does to it, and which gestures stay local.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import { TileViewport, type ViewportGestureTelemetry } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import { tileViewportHarness } from "@/features/desktop-viewer/tile-viewport/tileViewportHarness";

describe("TileViewport zoom and keyboard", () => {
  const {
    animationFrames,
    frameObservers,
    pointer,
    renderPointerSurface,
    scaleOf,
  } = tileViewportHarness();

  it("fills the strip the keyboard leaves and aims it at the cursor, then puts the view back", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const surfaceFor = (keyboardPresented: boolean) => (
      <TileViewport pointerMode keyboardPresented={keyboardPresented}
        sourceWidth={800} sourceHeight={500} initialCursor={{ x: 200, y: 250 }}>
        <div data-testid="content" />
      </TileViewport>
    );
    const { rerender } = render(surfaceFor(false));
    const content = screen.getByTestId("content").parentElement!;
    const frame = content.parentElement!;
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 1000 },
    });
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");

    // The keyboard flag lands before the box changes, exactly as the surface drives it: the
    // accessory has to mount and be measured before the video's box knows how short to be.
    rerender(surfaceFor(true));
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 500 });
    act(() => frameObservers.get(frame)!());

    // 800x500 in an 800x500 box already fills it, so covering asks for no zoom and the cursor
    // cannot be centred on an axis with nothing to pan.
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");

    // A taller strip does letterbox, and that is the case the cover exists for.
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 1000 });
    rerender(surfaceFor(false));
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 800 });
    rerender(surfaceFor(true));
    act(() => frameObservers.get(frame)!());
    expect(content.style.transform).toBe("translate(0px, -240px) scale(1.6)");

    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 1000 });
    rerender(surfaceFor(false));
    act(() => frameObservers.get(frame)!());
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("keeps a zoom the viewer chose when the keyboard opens over it", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const surfaceFor = (keyboardPresented: boolean) => (
      <TileViewport keyboardPresented={keyboardPresented}
        sourceWidth={800} sourceHeight={500} initialCursor={{ x: 200, y: 250 }}>
        <div data-testid="content" />
      </TileViewport>
    );
    const { rerender } = render(surfaceFor(false));
    const content = screen.getByTestId("content").parentElement!;
    const frame = content.parentElement!;
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 1000 },
    });

    // Zoom in the way a viewer does, with a double tap.
    pointer(frame, "pointerdown", 1, 400, 500);
    pointer(frame, "pointerup", 1, 400, 500);
    pointer(frame, "pointerdown", 1, 400, 500);
    pointer(frame, "pointerup", 1, 400, 500);
    const zoomed = content.style.transform;
    expect(zoomed).toContain("scale(2.5)");

    // The keyboard shortens the box. The cover exists for a view nobody chose; this one was
    // chosen, so it stays at the scale the viewer put it at.
    rerender(surfaceFor(true));
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 800 });
    act(() => frameObservers.get(frame)!());
    expect(content.style.transform).toContain("scale(2.5)");

    // And closing the keyboard has nothing of its own to put back.
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 1000 });
    rerender(surfaceFor(false));
    act(() => frameObservers.get(frame)!());
    expect(content.style.transform).toBe(zoomed);
  });

  it("re-clamps a zoomed pan when the keyboard shortens the box", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    render(
      <TileViewport sourceWidth={800} sourceHeight={500} initialCursor={{ x: 400, y: 250 }}>
        <div data-testid="content" />
      </TileViewport>,
    );
    const content = screen.getByTestId("content").parentElement!;
    const surface = content.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });

    // Double-tap near the bottom edge: 2.5x about (400, 480) lands ty at -720, legal only while
    // the box is 500 tall.
    for (const _ of [0, 1]) {
      pointer(surface, "pointerdown", 1, 400, 480);
      pointer(surface, "pointerup", 1, 400, 480);
    }
    expect(content.style.transform).toBe("translate(-600px, -720px) scale(2.5)");

    Object.defineProperty(surface, "clientHeight", { configurable: true, value: 200 });
    act(() => frameObservers.get(surface)!());

    // Without the clamp the picture keeps ty at -720 and its bottom edge pulls inside the shorter
    // box, showing black under the video.
    expect(content.style.transform).toBe("translate(-600px, -300px) scale(2.5)");
  });

  it("uses two fingers to pinch and pan locally without sending remote input", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    const transformed = screen.getByTestId("content").parentElement!;

    pointer(surface, "pointerdown", 1, 200, 250);
    pointer(surface, "pointerdown", 2, 600, 250);
    pointer(surface, "pointermove", 2, 700, 250);
    const afterPinch = transformed.style.transform;
    expect(scaleOf(afterPinch)).toBeCloseTo(1.25);

    pointer(surface, "pointermove", 1, 250, 280);
    pointer(surface, "pointermove", 2, 750, 280);
    expect(transformed.style.transform).not.toBe(afterPinch);
    expect(scaleOf(transformed.style.transform)).toBeCloseTo(1.25);

    pointer(surface, "pointermove", 2, 650, 280);
    expect(transformed.style.transform).toBe("translate(0px, 0px) scale(1)");

    pointer(surface, "pointerup", 2, 650, 280);
    pointer(surface, "pointerup", 1, 250, 280);

    expect(inputs).toEqual([]);
  });

  it("keeps one-finger pointer movement working after the viewport was zoomed", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });
    const transformed = screen.getByTestId("content").parentElement!;

    pointer(surface, "pointerdown", 1, 200, 250);
    pointer(surface, "pointerdown", 2, 600, 250);
    pointer(surface, "pointermove", 2, 700, 250);
    pointer(surface, "pointerup", 2, 700, 250);
    pointer(surface, "pointerup", 1, 200, 250);
    const zoomedTransform = transformed.style.transform;

    pointer(surface, "pointerdown", 3, 100, 100);
    pointer(surface, "pointermove", 3, 112, 106);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 3, 112, 106);

    expect(inputs.some((input) => input.type === "pointer-move")).toBe(true);
    expect(inputs.some((input) => input.type === "click")).toBe(false);
    expect(transformed.style.transform).toBe(zoomedTransform);
  });

  it("follows the pointer across remaining zoomed video without changing scale", () => {
    const inputs: DesktopPointerInput[] = [];
    const surface = renderPointerSurface(
      (input) => {
        inputs.push(input);
        return true;
      },
      { width: 800, height: 500, cursor: { x: 400, y: 250 } },
    );
    const transformed = screen.getByTestId("content").parentElement!;

    pointer(surface, "pointerdown", 1, 200, 250);
    pointer(surface, "pointerdown", 2, 600, 250);
    pointer(surface, "pointermove", 2, 700, 250);
    pointer(surface, "pointerup", 2, 700, 250);
    pointer(surface, "pointerup", 1, 200, 250);
    const zoomedScale = scaleOf(transformed.style.transform);
    const beforeFollow = transformed.style.transform;

    pointer(surface, "pointerdown", 3, 100, 100);
    pointer(surface, "pointermove", 3, 300, 100);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 3, 300, 100);

    expect(inputs.some((input) => input.type === "pointer-move")).toBe(true);
    expect(transformed.style.transform).not.toBe(beforeFollow);
    expect(scaleOf(transformed.style.transform)).toBe(zoomedScale);
  });

  it("reports bounded pinch-pan and zoomed pointer gesture lifecycles", () => {
    const telemetry: ViewportGestureTelemetry[] = [];
    const surface = render(
      <TileViewport
        pointerMode
        sendPointerInput={() => true}
        onGestureTelemetry={(event) => telemetry.push(event)}
      >
        <div data-testid="telemetry-content" />
      </TileViewport>,
    ).getByTestId("telemetry-content").parentElement!.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });

    pointer(surface, "pointerdown", 1, 200, 250);
    pointer(surface, "pointerdown", 2, 600, 250);
    pointer(surface, "pointermove", 2, 700, 250);
    pointer(surface, "pointerup", 2, 700, 250);
    pointer(surface, "pointerup", 1, 200, 250);
    pointer(surface, "pointerdown", 3, 100, 100);
    pointer(surface, "pointermove", 3, 112, 106);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 3, 112, 106);

    const gestures = telemetry.filter(
      (event): event is Exclude<ViewportGestureTelemetry, { phase: "viewport-settle" }> =>
        event.phase !== "viewport-settle",
    );
    expect(gestures.map(({ phase, detail }) => [phase, detail.kind, detail.outcome])).toEqual([
      ["viewport-gesture-start", "pinch-pan", undefined],
      ["viewport-gesture-end", "pinch-pan", "transformed"],
      ["viewport-gesture-start", "pointer", undefined],
      ["viewport-gesture-end", "pointer", "move"],
    ]);
    expect(gestures[1]?.detail.scale).toBeCloseTo(1.25);
    expect(gestures[3]?.detail.scale).toBeCloseTo(1.25);
    expect(gestures[3]?.detail.inputAccepted).toBe(true);
    expect(gestures[3]?.detail.edgeFollowed).toBe(false);
    expect(telemetry.every(({ gestureId }) => /^[0-9a-f-]{36}$/.test(gestureId))).toBe(true);
  });
});
