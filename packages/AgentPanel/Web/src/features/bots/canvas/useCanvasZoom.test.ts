/**
 * The canvas zoom's arithmetic, and what it remembers.
 *
 * Only the pure half is here, and that is a statement about what a unit test can see rather than
 * about what is worth testing. jsdom measures nothing -- every `getBoundingClientRect` is zeros and
 * every `offsetWidth` is zero -- so a test asserting that a pinch holds its focal point would pass
 * against any implementation at all, including one that ignored the pointer. That is what
 * `chrome-test/canvas-zoom-verify.mjs` is for. What IS settled here is the arithmetic those
 * gestures hand their numbers to, which is where the mistakes actually live.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_CANVAS_ZOOM,
  clampZoom,
  effectiveScale,
  fitScale,
  focalScroll,
  loadCanvasZoomMode,
  loadCanvasZoomScale,
  storeCanvasZoomMode,
  storeCanvasZoomScale,
} from "@/features/bots/canvas/useCanvasZoom";

const MODE_KEY = "agent-panel.bot-canvas.zoom-mode";
const SCALE_KEY = "agent-panel.bot-canvas.zoom-scale";

/** jsdom lays nothing out, so a node is the two numbers `effectiveScale` actually reads. */
function node(offsetWidth: number, drawnWidth: number): HTMLElement {
  return {
    offsetWidth,
    getBoundingClientRect: () => ({ width: drawnWidth }) as DOMRect,
  } as unknown as HTMLElement;
}

describe("how far out the canvas fits", () => {
  it("takes the tighter of the two axes, so the whole strip is inside the panel", () => {
    // A strip four screens wide and half a screen tall is bounded by its width; the point of the
    // mode is that nothing is left off the edge.
    expect(fitScale({ width: 4000, height: 400 }, { width: 1000, height: 800 })).toBe(0.25);
    expect(fitScale({ width: 1000, height: 1600 }, { width: 1000, height: 800 })).toBe(0.5);
  });

  it("never magnifies, because this mode only zooms out", () => {
    // A canvas smaller than the panel already fits. Scaling it up would be a different feature and
    // one nobody asked for: 1 is the size the cards were designed at.
    expect(fitScale({ width: 200, height: 100 }, { width: 1000, height: 800 })).toBe(1);
  });

  it("answers 1 rather than infinity before anything has been measured", () => {
    // The first layout runs before the ResizeObserver reports, and a fit computed by dividing by
    // zero would draw the canvas at Infinity for a frame.
    expect(fitScale({ width: 0, height: 0 }, { width: 1000, height: 800 })).toBe(1);
    expect(fitScale({ width: 4000, height: 400 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("holding a scale between fit and its own size", () => {
  it("stops at fit going out and at 1 coming in", () => {
    expect(clampZoom(0.1, 0.25)).toBe(0.25);
    expect(clampZoom(4, 0.25)).toBe(1);
    expect(clampZoom(0.5, 0.25)).toBe(0.5);
  });

  it("resolves the smallest storable number to fit, so an unpinched mode opens whole", () => {
    // Which is what makes MIN_CANVAS_ZOOM usable as the default: the floor is computed, not stored.
    expect(clampZoom(MIN_CANVAS_ZOOM, 0.3)).toBe(0.3);
  });

  it("treats an unreadable scale as fit rather than as a canvas nobody can see", () => {
    expect(clampZoom(Number.NaN, 0.3)).toBe(0.3);
  });
});

describe("holding the point under the fingers still", () => {
  it("keeps the content under the pointer under the pointer", () => {
    // The whole of the gesture. At 0.5 the content 800px into the scroller is 1600 into the strip;
    // drawn at 1 that content sits at 1600, so the scroller has to be at 1600 - 400 to leave it
    // under a finger 400px into the panel.
    const at = { scrollLeft: 800, scrollTop: 0, pointerX: 400, pointerY: 0, padLeft: 0, padTop: 0 };
    expect(focalScroll(at, 0.5, 1)).toEqual({ left: 2000, top: 0 });

    // And back again, which has to return where it came from or a pinch in and out drifts.
    expect(focalScroll({ ...at, scrollLeft: 2000 }, 1, 0.5)).toEqual({ left: 800, top: 0 });
  });

  it("holds the point under the fingers through the room around the canvas", () => {
    // The same gesture with the canvas sitting half a panel in. The content under the finger is
    // (800 + 400 - 500) / 0.5 = 1400, which drawn at 1 and put back behind the same room leaves
    // the scroller at 1400 + 500 - 400. Forgetting the room holds a point half a panel away.
    const at = { scrollLeft: 800, scrollTop: 0, pointerX: 400, pointerY: 0, padLeft: 500, padTop: 0 };
    expect(focalScroll(at, 0.5, 1)).toEqual({ left: 1500, top: 0 });
    expect(focalScroll({ ...at, scrollLeft: 1500 }, 1, 0.5)).toEqual({ left: 800, top: 0 });
  });

  it("never asks for an offset behind the start, which no scroller can be at", () => {
    // Zooming out near the left edge computes a negative offset; the browser would clamp it and
    // the next gesture would then read a scroll position that never happened.
    expect(
      focalScroll({ scrollLeft: 0, scrollTop: 0, pointerX: 400, pointerY: 300, padLeft: 0, padTop: 0 }, 1, 0.5),
    ).toEqual({ left: 0, top: 0 });
  });

  it("leaves the scroller alone rather than dividing by a scale of zero", () => {
    expect(
      focalScroll({ scrollLeft: 120, scrollTop: 40, pointerX: 0, pointerY: 0, padLeft: 0, padTop: 0 }, 0, 1),
    ).toEqual({ left: 120, top: 40 });
  });
});

describe("what an element is actually drawn at", () => {
  it("reads the scale off the element rather than being told it", () => {
    expect(effectiveScale(node(400, 120))).toBe(0.3);
  });

  it("snaps to exactly 1 when nothing is scaling it", () => {
    // The guard that matters. `offsetWidth` is a rounded integer where the rect is not, so an
    // untransformed card measures a fraction of a percent off 1 -- and with the mode OFF every
    // drag divides by this, so it has to be one exactly or a drag drifts where it never did.
    expect(effectiveScale(node(446, 446.4))).toBe(1);
    expect(effectiveScale(node(446, 446))).toBe(1);
  });

  it("answers 1 for anything it cannot measure, instead of scaling by zero or NaN", () => {
    expect(effectiveScale(null)).toBe(1);
    expect(effectiveScale(node(0, 0))).toBe(1);
    expect(effectiveScale(node(400, 0))).toBe(1);
  });
});

describe("what the canvas remembers about the mode", () => {
  beforeEach(() => localStorage.clear());

  it("is off until a reader turns it on, and comes back on after that", () => {
    expect(loadCanvasZoomMode()).toBe(false);
    storeCanvasZoomMode(true);
    expect(loadCanvasZoomMode()).toBe(true);
    storeCanvasZoomMode(false);
    expect(loadCanvasZoomMode()).toBe(false);
    // Off is the absence of the key rather than a stored "false", so nothing is left behind.
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
  });

  it("opens at fit before anything has been pinched", () => {
    expect(loadCanvasZoomScale()).toBe(MIN_CANVAS_ZOOM);
  });

  it("remembers how far out the reader left it", () => {
    storeCanvasZoomScale(0.42);
    expect(loadCanvasZoomScale()).toBe(0.42);
  });

  it("falls back to fit rather than trusting a scale it cannot read", () => {
    // A hand-edited or stale value must not become a canvas drawn at a size no gesture can undo.
    for (const bad of ["not a number", "0", "-1", "8", ""]) {
      localStorage.setItem(SCALE_KEY, bad);
      expect(loadCanvasZoomScale()).toBe(MIN_CANVAS_ZOOM);
    }
  });

  it("refuses to store a scale outside the range it would refuse to read", () => {
    storeCanvasZoomScale(0.42);
    storeCanvasZoomScale(12);
    expect(localStorage.getItem(SCALE_KEY)).toBeNull();
    expect(loadCanvasZoomScale()).toBe(MIN_CANVAS_ZOOM);
  });
});
