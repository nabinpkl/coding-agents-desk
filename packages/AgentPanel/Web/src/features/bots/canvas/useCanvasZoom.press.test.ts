// A press on the canvas around the strip is not a zoom.
//
// It used to be: a press below a card zoomed to that card at its own size, and one beside every
// card zoomed to 1. On a phone the tap that closes the keyboard lands exactly there, so typing into
// a card on a zoomed-out canvas cost the reader the scale they had pinched to (reported
// 2026-10-19). Pinch and the sidebar toggle are the ways in and out now.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCanvasZoomScale, storeCanvasZoomScale, useCanvasZoom } from "@/features/bots/canvas/useCanvasZoom";

// jsdom lays nothing out, so the strip and the panel are given the sizes the hook measures: a
// strip 2000x500 in a panel 800x400 fits at 0.4, so a stored 0.6 is drawn as 0.6.
const SIZES: Record<string, Record<string, number>> = {
  UL: { offsetWidth: 2000, offsetHeight: 500 },
  DIV: { clientWidth: 800, clientHeight: 400 },
};
const MEASURED = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;

beforeEach(() => {
  localStorage.clear();
  for (const name of MEASURED) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return SIZES[this.tagName]?.[name] ?? 0;
      },
    });
  }
});

afterEach(() => {
  for (const name of MEASURED) Reflect.deleteProperty(HTMLElement.prototype, name);
  document.body.replaceChildren();
});

describe("a press on the canvas around the strip", () => {
  it("leaves the scale the reader pinched to", () => {
    storeCanvasZoomScale(0.6);
    const scroller = document.createElement("div");
    const sizer = document.createElement("div");
    const strip = document.createElement("ul");
    sizer.append(strip);
    scroller.append(sizer);
    document.body.append(scroller);

    // Held outside the render, as a component's refs are: a new ref each render re-measures each render.
    const refs = { scroller: { current: scroller }, strip: { current: strip } };
    const { result } = renderHook(() => useCanvasZoom({ ...refs, on: true, room: 0 }));
    expect(result.current.scale).toBe(0.6);

    // Below the strip, where the tap that closes a phone keyboard lands on a zoomed-out canvas.
    act(() => {
      sizer.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 300, clientY: 380 }));
    });

    expect(result.current.scale).toBe(0.6);
    expect(loadCanvasZoomScale()).toBe(0.6);
  });
});
