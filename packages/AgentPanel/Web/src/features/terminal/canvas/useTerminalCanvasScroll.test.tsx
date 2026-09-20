// The keyboard moves the strip without the reader: focusing a tile scrolls it into the
// shrunken viewport, and the shortening document clamps what was already scrolled. Either one
// reaching storage is how a zoomed canvas stops showing what it showed before the keyboard came
// up -- so while the keyboard covers the page nothing is stored, and closing it puts the
// pre-keyboard offset back on screen.

import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalCanvasScroll } from "@/features/terminal/canvas/useTerminalCanvasScroll";

const SCROLL_KEY = "agent-panel.terminal-canvas.scroll";
// jsdom's default; the keyboard tests shrink the visual viewport below it.
const LAYOUT_HEIGHT = 768;

type Viewport = EventTarget & { height: number; offsetTop: number };

function Harness({ scale = 1 }: { scale?: number }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const remember = useTerminalCanvasScroll(scroller, "content", {
    scale,
    ready: true,
    pad: { left: 0, top: 0 },
  });
  return <div ref={scroller} onScroll={remember} data-testid="scroller" />;
}

function scroller(): HTMLElement {
  return screen.getByTestId("scroller");
}

function scrolledTo(left: number, top: number): void {
  const el = scroller();
  act(() => {
    el.scrollLeft = left;
    el.scrollTop = top;
  });
  fireEvent.scroll(el);
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

function stored(): { left: number; top: number } | null {
  const raw = localStorage.getItem(SCROLL_KEY);
  return raw ? (JSON.parse(raw) as { left: number; top: number }) : null;
}

describe("useTerminalCanvasScroll with a software keyboard", () => {
  const realInnerHeight = window.innerHeight;
  const realViewport = window.visualViewport;
  let viewport: Viewport;
  let field: HTMLTextAreaElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: LAYOUT_HEIGHT });
  });

  afterEach(() => {
    vi.useRealTimers();
    field?.remove();
    field = null;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: realInnerHeight });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: realViewport });
  });

  function stubViewport(): void {
    viewport = Object.assign(new EventTarget(), { height: LAYOUT_HEIGHT, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  }

  /** A keyboard over the page: a focused text field plus a visual viewport shrunk past the
   *  inset floor, the same inputs the document inset is published from. */
  function openKeyboard(): void {
    stubViewport();
    field = document.createElement("textarea");
    document.body.appendChild(field);
    act(() => {
      field!.focus();
    });
    viewport.height = 400;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
  }

  function closeKeyboard(): void {
    act(() => {
      field!.blur();
    });
    field!.remove();
    field = null;
    viewport.height = LAYOUT_HEIGHT;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("focusout"));
    });
  }

  it("stores an ordinary scroll, so the guard below has something to protect", () => {
    render(<Harness />);
    scrolledTo(250, 60);
    settle();
    expect(stored()).toEqual({ left: 250, top: 60 });
  });

  it("does not store the browser's scroll-into-view while the keyboard is up", () => {
    // Zoomed out, where the canvas is an overview rather than a strip to crawl: content-space
    // 100x50 sits at 45x22.5 on screen.
    render(<Harness scale={0.45} />);
    scrolledTo(45, 22.5);
    settle();
    expect(stored()).toEqual({ left: 100, top: 50 });

    openKeyboard();
    // The browser jumps the focused tile into the shrunken viewport. The settle timer would
    // happily write this down after the keyboard closed; judged at event time, it never lands.
    scrolledTo(400, 300);
    settle();
    expect(stored()).toEqual({ left: 100, top: 50 });
  });

  it("puts the canvas back where it was when the keyboard closes", () => {
    render(<Harness scale={0.45} />);
    scrolledTo(45, 22.5);
    settle();

    openKeyboard();
    scrolledTo(400, 300);
    expect(scroller().scrollLeft).toBe(400);

    // The browser restores neither the jump nor the clamp, so the close does: the last
    // truthful offset, back through the scale in force.
    closeKeyboard();
    expect(scroller().scrollLeft).toBeCloseTo(45, 5);
    expect(scroller().scrollTop).toBeCloseTo(22.5, 5);
    expect(stored()).toEqual({ left: 100, top: 50 });
  });
});
