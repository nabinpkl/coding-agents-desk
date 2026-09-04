import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import { TileViewport, type ViewportGestureTelemetry } from "./TileViewport";

describe("TileViewport pointer mode", () => {
  const animationFrames: FrameRequestCallback[] = [];
  /** jsdom has no ResizeObserver, and the viewport now watches its own frame for the keyboard. */
  const frameObservers = new Map<Element, () => void>();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(element: Element) { frameObservers.set(element, this.callback); }
      disconnect() {}
    });
  });

  afterEach(() => {
    animationFrames.length = 0;
    frameObservers.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderPointerSurface(
    send: (input: DesktopPointerInput) => boolean,
    source?: { width: number; height: number; cursor: { x: number; y: number } },
    subscribeCursorEvents?: (listener: (event: WebrtcCursorEvent) => void) => () => void,
  ) {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    render(
      <TileViewport
        pointerMode
        sendPointerInput={send}
        sourceWidth={source?.width}
        sourceHeight={source?.height}
        initialCursor={source?.cursor}
        subscribeCursorEvents={subscribeCursorEvents}
      >
        <div data-testid="content" />
      </TileViewport>,
    );
    const surface = screen.getByTestId("content").parentElement!.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });
    return surface;
  }

  function pointer(
    surface: HTMLElement,
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    pointerId: number,
    clientX: number,
    clientY: number,
  ) {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    surface.dispatchEvent(event);
  }

  function scaleOf(transform: string): number {
    const match = /scale\(([^)]+)\)/.exec(transform);
    if (!match) throw new Error(`missing scale in transform: ${transform}`);
    return Number(match[1]);
  }

  function activatePuckWithKeyboard() {
    const puck = screen.getByTestId("pointer-scroll-puck");
    act(() => puck.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    return puck;
  }

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
    pointer(surface, "pointermove", 1, 45, 35);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 1, 45, 35);

    expect(inputs.some((input) => input.type === "pointer-move")).toBe(false);
    expect(inputs.some((input) => input.type === "click")).toBe(false);
    expect(inputs.filter((input) => input.type === "scroll").map((input) => input.phase))
      .toEqual(["began", "ended"]);
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

    expect(inputs.some((input) => input.type === "scroll" && input.phase === "momentumBegan"))
      .toBe(true);
    pointer(surface, "pointerdown", 2, 100, 20);
    expect(inputs.at(-1)).toEqual({
      type: "scroll", dx: 0, dy: 0, phase: "momentumEnded",
    });
    pointer(surface, "pointercancel", 2, 100, 20);
  });

  it("delays a physical puck tap for double-tap zoom arbitration", () => {
    vi.useFakeTimers();
    const surface = renderPointerSurface(
      () => true,
      { width: 800, height: 500, cursor: { x: 400, y: 250 } },
    );
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
        sendPointerInput={(input) => { inputs.push(input); return true; }}
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

  it("draws a fixed client cursor overlay at the predicted source point", () => {
    const surface = renderPointerSurface(
      () => true,
      { width: 800, height: 500, cursor: { x: 400, y: 250 } },
    );
    const overlay = screen.getByTestId("client-cursor-overlay");

    act(() => window.dispatchEvent(new Event("resize")));

    expect(overlay).not.toHaveAttribute("hidden");
    expect(overlay.style.transform).toBe("translate3d(400px, 250px, 0)");
    expect(overlay.querySelector("svg")).toHaveClass("h-3", "w-2");
    expect(surface.contains(overlay)).toBe(true);
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
    const fallback = overlay.querySelector("svg")!;
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

  it("sends immediately and corrects only from the newest applied move", () => {
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
    const predicted = overlay.style.transform;

    act(() => listener?.({ type: "cursor-position", x: 50, y: 250 }));
    expect(overlay.style.transform).toBe(predicted);

    act(() => listener?.({ type: "cursor-applied", revision: 1, x: 300, y: 250 }));
    expect(overlay.style.transform).toBe(predicted);

    act(() => listener?.({ type: "cursor-applied", revision: 2, x: 600, y: 250 }));
    expect(overlay.style.transform).toBe("translate3d(600px, 250px, 0)");

    act(() => listener?.({ type: "cursor-position", x: 650, y: 250 }));
    expect(overlay.style.transform).toBe("translate3d(650px, 250px, 0)");
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

    expect(telemetry.map(({ phase, detail }) => [phase, detail.kind, detail.outcome])).toEqual([
      ["viewport-gesture-start", "pinch-pan", undefined],
      ["viewport-gesture-end", "pinch-pan", "transformed"],
      ["viewport-gesture-start", "pointer", undefined],
      ["viewport-gesture-end", "pointer", "move"],
    ]);
    expect(telemetry[1]?.detail.scale).toBeCloseTo(1.25);
    expect(telemetry[3]?.detail.scale).toBeCloseTo(1.25);
    expect(telemetry[3]?.detail.inputAccepted).toBe(true);
    expect(telemetry[3]?.detail.edgeFollowed).toBe(false);
    expect(telemetry.every(({ gestureId }) => /^[0-9a-f-]{36}$/.test(gestureId))).toBe(true);
  });
});
