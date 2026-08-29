import { describe, expect, it } from "vitest";
import { clampPan, IDENTITY, panBy, toContentPoint, zoomAt } from "./tileViewportMath";

const W = 800;
const H = 500;

describe("zoomAt", () => {
  it("keeps the zoom point over the same content", () => {
    const zoomed = zoomAt(IDENTITY, 2, 400, 250, W, H);
    // The content point under the centre before (0.5, 0.5) is still there.
    expect(toContentPoint(zoomed, 400, 250, W, H)).toEqual({ x: 0.5, y: 0.5 });
    expect(zoomed.scale).toBe(2);
  });

  it("snaps back to identity when zooming out to 1", () => {
    const zoomed = zoomAt(IDENTITY, 2, 100, 100, W, H);
    const back = zoomAt(zoomed, 0.5, 700, 400, W, H);
    expect(back).toEqual(IDENTITY);
  });

  it("clamps scale to its bounds", () => {
    const far = zoomAt(IDENTITY, 100, 0, 0, W, H);
    expect(far.scale).toBe(8);
    expect(zoomAt(IDENTITY, 0.01, 0, 0, W, H).scale).toBe(1);
  });

  it("never shows past the content edge after a corner zoom", () => {
    const corner = zoomAt(IDENTITY, 3, W, H, W, H);
    // Bottom-right corner zoom: the pan sits at its clamped minimum.
    expect(corner.tx).toBe(W * (1 - 3));
    expect(corner.ty).toBe(H * (1 - 3));
  });
});

describe("panBy", () => {
  it("moves within bounds and stops at the edges", () => {
    const zoomed = zoomAt(IDENTITY, 2, 400, 250, W, H);
    const nudged = panBy(zoomed, -50, -30, W, H);
    expect(nudged.tx).toBe(zoomed.tx - 50);
    expect(nudged.ty).toBe(zoomed.ty - 30);
    const slammed = panBy(zoomed, -10_000, 10_000, W, H);
    expect(slammed.tx).toBe(W * (1 - 2));
    expect(slammed.ty).toBe(0);
  });

  it("cannot move at all at scale 1", () => {
    expect(panBy(IDENTITY, 55, -40, W, H)).toEqual(IDENTITY);
  });
});

describe("clampPan", () => {
  it("is idempotent", () => {
    const once = clampPan({ scale: 3, tx: -9999, ty: 42 }, W, H);
    expect(clampPan(once, W, H)).toEqual(once);
  });
});

describe("toContentPoint", () => {
  it("inverts the transform for remote-control mapping", () => {
    const zoomed = zoomAt(IDENTITY, 4, 200, 100, W, H);
    const point = toContentPoint(zoomed, 600, 300, W, H);
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(1);
    // Round-trip: the content point drawn back through the transform lands on
    // the same viewport pixel.
    expect(point.x * W * zoomed.scale + zoomed.tx).toBeCloseTo(600);
    expect(point.y * H * zoomed.scale + zoomed.ty).toBeCloseTo(300);
  });
});
