import { describe, expect, it } from "vitest";
import {
  advanceRemoteCursor,
  clampPan,
  coverOnRemoteCursor,
  followRemoteCursor,
  IDENTITY,
  panBy,
  pointerAccelerationGain,
  projectRemoteCursor,
  scrollAccelerationGain,
  toContentPoint,
  zoomAt,
} from "./tileViewportMath";

const W = 800;
const H = 500;

describe("remote pointer acceleration", () => {
  it("matches the native pointer gain and cap", () => {
    expect(pointerAccelerationGain(0)).toBe(1.5);
    expect(pointerAccelerationGain(400)).toBe(3.5);
    expect(pointerAccelerationGain(10_000)).toBe(10);
  });

  it("advances and clamps the same source-point cursor model as native", () => {
    expect(advanceRemoteCursor({ x: 790, y: 5 }, 50, -20, W, H)).toEqual({ x: 799, y: 0 });
  });
});

describe("remote scroll acceleration", () => {
  it("matches the native precision floor, slope, and cap", () => {
    expect(scrollAccelerationGain(0)).toBe(1);
    expect(scrollAccelerationGain(800)).toBe(4.6);
    expect(scrollAccelerationGain(10_000)).toBe(12);
  });
});

describe("followRemoteCursor", () => {
  it("pans at the safe-band edge without changing zoom", () => {
    const followed = followRemoteCursor(
      { scale: 2, tx: -400, ty: -250 },
      { x: 650, y: 250 },
      W,
      H,
      W,
      H,
    );

    expect(followed).toEqual({ scale: 2, tx: -596, ty: -250 });
  });

  it("does not pan an axis that has no additional video", () => {
    const transform = { scale: 1.1, tx: -40, ty: -25 };
    const followed = followRemoteCursor(
      transform,
      { x: 800, y: 899 },
      1600,
      900,
      W,
      H,
    );

    expect(followed.ty).toBe(transform.ty);
    expect(followed.scale).toBe(transform.scale);
  });
});

describe("projectRemoteCursor", () => {
  it("projects through aspect-fit letterboxing and the viewport transform", () => {
    expect(projectRemoteCursor(
      { scale: 2, tx: -200, ty: -100 },
      { x: 800, y: 450 },
      1600,
      900,
      800,
      500,
    )).toEqual({ x: 600, y: 400 });
  });

  it("returns no position until both source and viewport geometry exist", () => {
    expect(projectRemoteCursor(IDENTITY, { x: 1, y: 1 }, 0, 900, W, H)).toBeNull();
  });
});

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

  it("absorbs floating-point residue at the 1x boundary", () => {
    expect(zoomAt({ scale: 1.25, tx: -87.5, ty: -62.5 }, 0.8000000000000002, 400, 250, W, H))
      .toEqual(IDENTITY);
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

describe("coverOnRemoteCursor", () => {
  it("fills a letterboxed strip and centres the cursor in what is left", () => {
    // 800x500 source in a tall 800x1000 box: contain fits by width and leaves 250px of black
    // above and below. Covering doubles it so the picture is exactly as tall as the box.
    const centred = coverOnRemoteCursor({ x: 200, y: 250 }, 800, 500, 800, 1000);
    expect(centred).toEqual({ scale: 2, tx: 0, ty: -500 });
    // The cursor lands on the viewport's middle on the axis that has room to pan.
    expect(200 * 2 + centred.tx).toBe(400);

    // A wide 1000x200 strip, the shape the keyboard leaves in landscape: contain fits by height
    // and pillarboxes instead, so covering scales on the other axis.
    const strip = coverOnRemoteCursor({ x: 400, y: 250 }, 800, 500, 1000, 200);
    expect(strip.scale).toBeCloseTo(3.125);
    expect(strip.tx).toBeCloseTo(-1062.5);
    expect(strip.ty).toBeCloseTo(-212.5);
  });

  it("never pans a content edge inside the viewport to obey the cursor", () => {
    const atLeftEdge = coverOnRemoteCursor({ x: 0, y: 250 }, 800, 500, 800, 1000);
    expect(atLeftEdge.tx).toBe(0);
    const atRightEdge = coverOnRemoteCursor({ x: 800, y: 250 }, 800, 500, 800, 1000);
    expect(atRightEdge.tx).toBe(-800);
  });

  it("returns identity when there is no picture to cover", () => {
    expect(coverOnRemoteCursor({ x: 0, y: 0 }, 0, 0, 800, 500)).toBe(IDENTITY);
    expect(coverOnRemoteCursor({ x: 0, y: 0 }, 800, 500, 0, 0)).toBe(IDENTITY);
  });
});
