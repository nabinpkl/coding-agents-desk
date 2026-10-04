// The cursor the viewer sees: the overlay drawn at the predicted point, the images the host
// sends for it, and correcting a prediction from the newest applied move.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import { TileViewport, type ViewportGestureTelemetry } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import { tileViewportHarness } from "@/features/desktop-viewer/tile-viewport/tileViewportHarness";

describe("TileViewport cursor mirror", () => {
  const {
    activatePuckWithKeyboard,
    animationFrames,
    frameObservers,
    pointer,
    renderPointerSurface,
    scaleOf,
  } = tileViewportHarness();

  it("draws a fixed client cursor overlay at the predicted source point", () => {
    const surface = renderPointerSurface(
      () => true,
      { width: 800, height: 500, cursor: { x: 400, y: 250 } },
    );
    const overlay = screen.getByTestId("client-cursor-overlay");

    act(() => window.dispatchEvent(new Event("resize")));

    expect(overlay).not.toHaveAttribute("hidden");
    expect(overlay.style.transform).toBe("translate3d(400px, 250px, 0)");
    expect(screen.getByTestId("client-cursor-fallback")).toHaveClass("h-3", "w-2");
    expect(surface.contains(overlay)).toBe(true);
  });

  it("mirrors host cursor images, hotspots, kinds, and idle Mac movement", () => {
    let listener: ((event: WebrtcCursorEvent) => void) | undefined;
    const surface = renderPointerSurface(
      () => true,
      { width: 800, height: 500, cursor: { x: 100, y: 100 } },
      (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
    );
    const overlay = screen.getByTestId("client-cursor-overlay");
    const fallback = screen.getByTestId("client-cursor-fallback");
    const image = overlay.querySelector("img")!;

    act(() => listener?.({
      type: "cursor-image",
      hash: "ibeam",
      png: "AQID",
      hotspotXFrac: 0.5,
      hotspotYFrac: 0.25,
      widthPoints: 20,
      heightPoints: 40,
      hidden: false,
      cursorKind: "ibeam",
    }));

    expect(overlay.dataset.cursorKind).toBe("ibeam");
    expect(image).not.toHaveAttribute("hidden");
    expect(image).toHaveAttribute("src", "data:image/png;base64,AQID");
    expect(image.style.width).toBe("14px");
    expect(image.style.height).toBe("28px");
    expect(image.style.transform).toBe("translate(-7px, -7px)");
    expect(fallback).toHaveAttribute("hidden");

    act(() => listener?.({ type: "cursor-position", x: 600, y: 250 }));
    expect(overlay.style.transform).toBe("translate3d(600px, 250px, 0)");

    act(() => listener?.({
      type: "cursor-image",
      hash: "hand",
      png: "BAUG",
      hotspotXFrac: 0.25,
      hotspotYFrac: 0.1,
      widthPoints: 24,
      heightPoints: 24,
      hidden: false,
      cursorKind: "pointingHand",
    }));
    expect(overlay.dataset.cursorKind).toBe("pointingHand");
    expect(image).toHaveAttribute("src", "data:image/png;base64,BAUG");
    expect(surface.contains(overlay)).toBe(true);
  });

  it("sends immediately, corrects only from the newest applied move, and replays unconfirmed travel over the Mac's own", () => {
    const inputs: DesktopPointerInput[] = [];
    let listener: ((event: WebrtcCursorEvent) => void) | undefined;
    const surface = renderPointerSurface(
      (input) => {
        inputs.push(input);
        return true;
      },
      { width: 800, height: 500, cursor: { x: 100, y: 250 } },
      (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
    );
    const overlay = screen.getByTestId("client-cursor-overlay");

    pointer(surface, "pointerdown", 1, 10, 10);
    pointer(surface, "pointermove", 1, 18, 10);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointermove", 1, 26, 10);
    act(() => animationFrames.shift()?.(performance.now() + 32));

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ type: "pointer-move", revision: 1 });
    expect(inputs[1]).toMatchObject({ type: "pointer-move", revision: 2 });

    // The Mac moved its cursor itself while both moves were unconfirmed. Its position is the new
    // base and the finger's unconfirmed travel is replayed on top (ADR-0058), so the drawing moves
    // by exactly the Mac's own displacement and keeps what the finger did.
    const drawnX = () => Number(/translate3d\(([^p]+)px/.exec(overlay.style.transform)![1]);
    const predictedX = drawnX();
    act(() => listener?.({ type: "cursor-position", x: 50, y: 250 }));
    expect(drawnX()).toBeCloseTo(predictedX - 50, 9);
    expect(overlay.style.transform).toMatch(/, 250px, 0\)$/);

    const replayed = overlay.style.transform;
    act(() => listener?.({ type: "cursor-applied", revision: 1, x: 300, y: 250 }));
    expect(overlay.style.transform).toBe(replayed);

    act(() => listener?.({ type: "cursor-applied", revision: 2, x: 600, y: 250 }));
    expect(overlay.style.transform).toBe("translate3d(600px, 250px, 0)");

    act(() => listener?.({ type: "cursor-position", x: 650, y: 250 }));
    expect(overlay.style.transform).toBe("translate3d(650px, 250px, 0)");
  });
});
