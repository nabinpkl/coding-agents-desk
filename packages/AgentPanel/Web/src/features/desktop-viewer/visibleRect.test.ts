import { describe, expect, it } from "vitest";
import {
  MIN_VISIBLE_WIDTH,
  contentRect,
  followVisible,
  isWholeDisplay,
  magnification,
  panVisible,
  placeRegion,
  projectPoint,
  regionCovers,
  unprojectPoint,
  wholeDisplay,
  zoomVisible,
} from "./visibleRect";

const DISPLAY = { width: 1600, height: 1000 };

describe("zoomVisible", () => {
  it("keeps the anchor under the same screen spot", () => {
    // Zoom 2x about (400, 250): that point is a quarter of the way in on each axis, and it must
    // still be a quarter of the way into the new, half-sized rect.
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 2, { x: 400, y: 250 });
    expect(zoomed.width).toBe(800);
    expect(zoomed.height).toBe(500);
    expect((400 - zoomed.x) / zoomed.width).toBeCloseTo(0.25, 9);
    expect((250 - zoomed.y) / zoomed.height).toBeCloseTo(0.25, 9);
  });

  it("keeps the display's aspect, which is what makes projection one uniform scale", () => {
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 3.3, { x: 1000, y: 700 });
    expect(zoomed.width / zoomed.height).toBeCloseTo(DISPLAY.width / DISPLAY.height, 9);
  });

  it("stays inside the display when the anchor is near an edge", () => {
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 4, { x: 1590, y: 990 });
    expect(zoomed.x + zoomed.width).toBeLessThanOrEqual(DISPLAY.width);
    expect(zoomed.y + zoomed.height).toBeLessThanOrEqual(DISPLAY.height);
    expect(zoomed.x).toBeGreaterThanOrEqual(0);
  });

  it("stops at the minimum width and at the whole display", () => {
    const deep = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 1000, { x: 800, y: 500 });
    expect(deep.width).toBe(MIN_VISIBLE_WIDTH);
    const out = zoomVisible(deep, DISPLAY, 0.0001, { x: 800, y: 500 });
    expect(out).toEqual(wholeDisplay(DISPLAY));
  });

  it("reports magnification against the whole display", () => {
    expect(magnification(wholeDisplay(DISPLAY), DISPLAY)).toBe(1);
    expect(magnification({ x: 0, y: 0, width: 400, height: 250 }, DISPLAY)).toBe(4);
    expect(isWholeDisplay(wholeDisplay(DISPLAY), DISPLAY)).toBe(true);
  });
});

describe("panVisible", () => {
  it("moves by display points and clamps at the edges", () => {
    const zoomed = { x: 100, y: 100, width: 800, height: 500 };
    expect(panVisible(zoomed, DISPLAY, 50, -30)).toEqual({ x: 150, y: 70, width: 800, height: 500 });
    expect(panVisible(zoomed, DISPLAY, 5000, 5000)).toEqual({ x: 800, y: 500, width: 800, height: 500 });
  });
});

describe("followVisible", () => {
  const zoomed = { x: 400, y: 250, width: 800, height: 500 };

  it("does nothing while the cursor is inside the safe band", () => {
    expect(followVisible(zoomed, DISPLAY, { x: 800, y: 500 }, 0.18)).toBe(zoomed);
  });

  it("pans just enough to bring the cursor back to the band's edge", () => {
    // Inner band starts at 400 + 800*0.18 = 544. A cursor at 500 is 44 short: pan by -44.
    expect(followVisible(zoomed, DISPLAY, { x: 500, y: 500 }, 0.18)).toEqual({ ...zoomed, x: 356 });
  });

  it("does nothing at all when the whole display is already visible", () => {
    const whole = wholeDisplay(DISPLAY);
    expect(followVisible(whole, DISPLAY, { x: 1, y: 1 }, 0.18)).toBe(whole);
  });
});

describe("contentRect", () => {
  it("letterboxes to the display's aspect, centred", () => {
    // 16:10 display in a square viewport: full width, bars top and bottom.
    expect(contentRect(DISPLAY, 800, 800)).toEqual({ x: 0, y: 150, width: 800, height: 500 });
    // ...and in a very wide viewport: full height, bars left and right.
    expect(contentRect(DISPLAY, 2000, 500)).toEqual({ x: 600, y: 0, width: 800, height: 500 });
  });
});

describe("placeRegion", () => {
  const content = { x: 0, y: 0, width: 800, height: 500 };

  it("puts a region equal to the view exactly over the content box", () => {
    const visible = { x: 400, y: 250, width: 800, height: 500 };
    expect(placeRegion(visible, visible, content)).toEqual(content);
  });

  it("places a padded region so the visible part still lands on the content box", () => {
    // The capture is 20% wider than the view on each side; on screen it must overhang the box
    // by that much, so the box itself shows exactly what is visible.
    const visible = { x: 400, y: 250, width: 800, height: 500 };
    const region = { x: 240, y: 150, width: 1120, height: 700 };
    expect(placeRegion(region, visible, content)).toEqual({ x: -160, y: -100, width: 1120, height: 700 });
  });

  it("re-places an old frame immediately when the view zooms, before any new capture", () => {
    // The frame covers the whole display; zoom in 2x on the top-left quarter and the same frame
    // simply becomes twice as large, anchored so its top-left stays at the box's top-left.
    const whole = wholeDisplay(DISPLAY);
    const visible = { x: 0, y: 0, width: 800, height: 500 };
    expect(placeRegion(whole, visible, content)).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
  });
});

describe("project and unproject", () => {
  const content = contentRect(DISPLAY, 800, 800);
  const visible = { x: 400, y: 250, width: 800, height: 500 };

  it("round-trips a display point through the screen", () => {
    const point = { x: 1000, y: 600 };
    const screen = projectPoint(point, visible, content)!;
    const back = unprojectPoint(screen, visible, content, DISPLAY)!;
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("uses the same scale on both axes, so neither drifts", () => {
    const a = projectPoint({ x: 400, y: 250 }, visible, content)!;
    const b = projectPoint({ x: 1200, y: 750 }, visible, content)!;
    expect(b.x - a.x).toBeCloseTo(content.width, 9);
    expect(b.y - a.y).toBeCloseTo(content.height, 9);
  });

  it("clamps a pointer over the letterbox onto the display's edge", () => {
    const back = unprojectPoint({ x: 400, y: 0 }, wholeDisplay(DISPLAY), content, DISPLAY)!;
    expect(back.y).toBe(0);
  });
});

describe("regionCovers", () => {
  it("is the condition for showing a frame at all", () => {
    const visible = { x: 400, y: 250, width: 800, height: 500 };
    expect(regionCovers({ x: 240, y: 150, width: 1120, height: 700 }, visible)).toBe(true);
    expect(regionCovers({ x: 500, y: 150, width: 1120, height: 700 }, visible)).toBe(false);
  });
});
