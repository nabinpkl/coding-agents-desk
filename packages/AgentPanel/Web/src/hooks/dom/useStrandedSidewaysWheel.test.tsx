// A sideways swipe the browser gave to a transcript inside the strip moves the strip, and a swipe the
// browser is already moving the strip with, or one scrolling a wide block inside, is left alone.

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStrandedSidewaysWheel } from "@/hooks/dom/useStrandedSidewaysWheel";

/** A position that moves when set, held to [0, max], as an element's scroll offset is. */
function scrollable(element: HTMLElement, max: number): () => number {
  let left = 0;
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.max(0, Math.min(value, max));
    },
  });
  return () => left;
}

/** A strip holding a transcript that scrolls only up and down, with a wide code block in it. */
function stage() {
  const scroller = document.createElement("div");
  const strip = scrollable(scroller, 5000);
  const transcript = document.createElement("div");
  const text = document.createElement("p");
  const code = document.createElement("pre");
  code.style.overflowX = "auto";
  Object.defineProperty(code, "scrollWidth", { value: 600 });
  Object.defineProperty(code, "clientWidth", { value: 300 });
  const block = scrollable(code, 300);
  transcript.append(text, code);
  scroller.append(transcript);
  document.body.append(scroller);
  // Mounted after the hook, the order the page has it in.
  const { rerender } = renderHook(({ element }) => useStrandedSidewaysWheel(element), {
    initialProps: { element: null as HTMLElement | null },
  });
  rerender({ element: scroller });
  return { scroller, text, code, strip, block };
}

let clock = 1000;

/** One wheel, a frame after the last unless told otherwise. */
function wheel(target: Element, deltaX: number, deltaY: number, init: WheelEventInit = {}): void {
  const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, ...init });
  Object.defineProperty(event, "timeStamp", { value: clock });
  clock += 16;
  target.dispatchEvent(event);
}

describe("useStrandedSidewaysWheel", () => {
  afterEach(() => {
    document.body.replaceChildren();
    clock += 1000;
  });

  it("moves the strip by a sideways swipe the browser gave to the transcript, glide included", () => {
    const { text, strip } = stage();
    // A pixel of upward drift is enough for the browser to give the swipe to the transcript, and
    // in this test nothing moves the strip but the hook, as on the page.
    wheel(text, 2, -6);
    for (let i = 0; i < 10; i += 1) wheel(text, 40, -1);
    // The first sideways wheel is where it starts watching, and the next one shows nothing moved:
    // from the third, every wheel moves the strip.
    expect(strip()).toBe(8 * 40);
    for (let i = 0; i < 5; i += 1) wheel(text, 10, 0);
    expect(strip()).toBe(8 * 40 + 50);
  });

  it("leaves a swipe the browser is moving the strip with, so none is applied twice", () => {
    const { scroller, text, strip } = stage();
    for (let i = 0; i < 10; i += 1) {
      scroller.scrollLeft += 40;
      wheel(text, 40, -1);
    }
    expect(strip()).toBe(400);
  });

  it("stands down the moment the browser starts moving the strip itself", () => {
    const { scroller, text, strip } = stage();
    for (let i = 0; i < 3; i += 1) wheel(text, 40, -1);
    expect(strip()).toBe(40);
    for (let i = 0; i < 5; i += 1) {
      scroller.scrollLeft += 40;
      wheel(text, 40, -1);
    }
    expect(strip()).toBe(40 + 5 * 40);
  });

  it("leaves a swipe that scrolls a wide block inside to that block, past the block's end", () => {
    const { code, strip, block } = stage();
    for (let i = 0; i < 15; i += 1) {
      code.scrollLeft += 40;
      wheel(code, 40, 0);
    }
    expect(block()).toBe(300);
    expect(strip()).toBe(0);
  });

  it("never starts on an up-and-down scroll with some sideways drift in it", () => {
    const { text, strip } = stage();
    for (let i = 0; i < 20; i += 1) wheel(text, 3, -20);
    expect(strip()).toBe(0);
  });

  it("starts watching afresh after a pause, since that is a new swipe", () => {
    const { text, strip } = stage();
    for (let i = 0; i < 4; i += 1) wheel(text, 40, -1);
    expect(strip()).toBe(80);
    clock += 400;
    wheel(text, 40, -1);
    wheel(text, 40, -1);
    expect(strip()).toBe(80);
    wheel(text, 40, -1);
    expect(strip()).toBe(120);
  });

  it("leaves a pinch to the zoom, and a wheel something inside took for itself", () => {
    const { text, strip } = stage();
    for (let i = 0; i < 6; i += 1) wheel(text, 40, -1, { ctrlKey: true });
    expect(strip()).toBe(0);
    const take = (event: Event) => event.preventDefault();
    text.addEventListener("wheel", take);
    clock += 400;
    for (let i = 0; i < 6; i += 1) wheel(text, 40, -1, { cancelable: true });
    expect(strip()).toBe(0);
    text.removeEventListener("wheel", take);
  });

  it("reads a line-mode wheel in lines", () => {
    const { text, strip } = stage();
    clock += 400;
    for (let i = 0; i < 4; i += 1) wheel(text, 3, 0, { deltaMode: 1 });
    expect(strip()).toBe(2 * 3 * 16);
  });
});
