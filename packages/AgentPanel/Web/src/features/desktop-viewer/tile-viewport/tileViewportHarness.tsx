// One rendered TileViewport, with the browser pieces jsdom does not have.
//
// A module rather than a copy per file: the surface is rendered with its own animation
// frames and ResizeObserver stubbed, and `pointer` dispatches the MouseEvents jsdom will
// build where it will not build PointerEvents.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import { TileViewport } from "@/features/desktop-viewer/tile-viewport/TileViewport";

/**
 * Stands up the frame stubs and the animation-frame queue, and hands back the helpers.
 *
 * Registers its own `beforeEach`/`afterEach`, so call it once inside a `describe`.
 */
export function tileViewportHarness() {
  const animationFrames: FrameRequestCallback[] = [];
  /** jsdom has no ResizeObserver, and the viewport now watches its own frame for the keyboard. */
  const frameObservers = new Map<Element, () => void>();

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe(element: Element) {
          frameObservers.set(element, this.callback);
        }
        disconnect() {}
      },
    );
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
    absolutePointer = false,
  ) {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    render(
      <TileViewport
        pointerMode
        absolutePointer={absolutePointer}
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
    pointerType = "touch",
  ) {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    Object.defineProperty(event, "pointerType", { value: pointerType });
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

  return {
    activatePuckWithKeyboard,
    animationFrames,
    frameObservers,
    pointer,
    renderPointerSurface,
    scaleOf,
  };
}
