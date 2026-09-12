import { describe, expect, it } from "vitest";
import {
  MIN_VISIBLE_SIDE,
  centreVisible,
  fitRect,
  followVisible,
  isWholeDisplay,
  largestFitting,
  magnification,
  panVisible,
  placeRegion,
  projectPoint,
  regionCovers,
  unprojectPoint,
  wholeDisplay,
  zoomVisible,
} from "@/features/desktop-viewer/visibleRect";

const DISPLAY = { width: 1600, height: 1000 };
/** Same aspect as the display: the DeskZoom case, where nothing is ever letterboxed. */
const SAME = { width: 800, height: 500 };
/** Wider than the display, like a panel with chrome above and below the picture. */
const WIDE = { width: 1000, height: 400 };

describe("zoomVisible", () => {
  it("keeps the anchor under the same screen spot", () => {
    // Zoom 2x about (400, 250): that point is a quarter of the way in on each axis, and it must
    // still be a quarter of the way into the new, half-sized rect.
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 2, { x: 400, y: 250 }, SAME);
    expect(zoomed.width).toBeCloseTo(800, 9);
    expect(zoomed.height).toBeCloseTo(500, 9);
    expect((400 - zoomed.x) / zoomed.width).toBeCloseTo(0.25, 9);
    expect((250 - zoomed.y) / zoomed.height).toBeCloseTo(0.25, 9);
  });

  it("takes the viewport's aspect when zoomed in, so the picture fills the viewport", () => {
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 3, { x: 800, y: 500 }, WIDE);
    expect(zoomed.width / zoomed.height).toBeCloseTo(WIDE.width / WIDE.height, 9);
    // ...and the box it is shown in is then the whole viewport: no bars.
    const box = fitRect(zoomed, WIDE.width, WIDE.height);
    expect(box.x).toBeCloseTo(0, 6);
    expect(box.y).toBeCloseTo(0, 6);
    expect(box.width).toBeCloseTo(1000, 6);
    expect(box.height).toBeCloseTo(400, 6);
  });

  it("means the same zoom factor whether or not an axis is clamped: a quarter of the area", () => {
    const whole = wholeDisplay(DISPLAY);
    const zoomed = zoomVisible(whole, DISPLAY, 2, { x: 800, y: 500 }, WIDE);
    expect(zoomed.width * zoomed.height).toBeCloseTo((whole.width * whole.height) / 4, 6);
  });

  it("reaches the whole display, and the letterbox, only once both axes are bounded", () => {
    // Zooming out in a wide viewport: width hits the display first, height keeps growing.
    const deep = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 4, { x: 800, y: 500 }, WIDE);
    const partly = zoomVisible(deep, DISPLAY, 1 / 3, { x: 800, y: 500 }, WIDE);
    expect(partly.width).toBe(DISPLAY.width);
    expect(partly.height).toBeLessThan(DISPLAY.height);
    expect(isWholeDisplay(partly, DISPLAY)).toBe(false);
    const out = zoomVisible(partly, DISPLAY, 1 / 100, { x: 800, y: 500 }, WIDE);
    expect(out).toEqual(wholeDisplay(DISPLAY));
  });

  it("stays inside the display when the anchor is near an edge", () => {
    const zoomed = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 4, { x: 1590, y: 990 }, WIDE);
    expect(zoomed.x + zoomed.width).toBeLessThanOrEqual(DISPLAY.width + 1e-9);
    expect(zoomed.y + zoomed.height).toBeLessThanOrEqual(DISPLAY.height + 1e-9);
    expect(zoomed.x).toBeGreaterThanOrEqual(0);
  });

  it("stops at the floor on the shorter axis", () => {
    const deep = zoomVisible(wholeDisplay(DISPLAY), DISPLAY, 1000, { x: 800, y: 500 }, WIDE);
    expect(Math.min(deep.width, deep.height)).toBeCloseTo(MIN_VISIBLE_SIDE, 6);
  });

  it("reports magnification against the whole display on the more zoomed axis", () => {
    expect(magnification(wholeDisplay(DISPLAY), DISPLAY)).toBe(1);
    expect(magnification({ x: 0, y: 0, width: 400, height: 250 }, DISPLAY)).toBe(4);
    expect(magnification({ x: 0, y: 0, width: 1600, height: 500 }, DISPLAY)).toBe(2);
  });
});

describe("largestFitting", () => {
  it("is the most of the display that fills a viewport of that aspect without bars", () => {
    expect(largestFitting(DISPLAY, 2.5)).toEqual({ width: 1600, height: 640 });
    expect(largestFitting(DISPLAY, 1)).toEqual({ width: 1000, height: 1000 });
  });
});

describe("panVisible", () => {
  it("moves by display points and clamps at the edges", () => {
    const zoomed = { x: 100, y: 100, width: 800, height: 500 };
    expect(panVisible(zoomed, DISPLAY, 50, -30)).toEqual({ x: 150, y: 70, width: 800, height: 500 });
    expect(panVisible(zoomed, DISPLAY, 5000, 5000)).toEqual({ x: 800, y: 500, width: 800, height: 500 });
  });

  it("returns the same rect when nothing could move, so nothing downstream re-runs", () => {
    const whole = wholeDisplay(DISPLAY);
    expect(panVisible(whole, DISPLAY, 10, 10)).toBe(whole);
  });
});

describe("followVisible and centreVisible", () => {
  const zoomed = { x: 400, y: 250, width: 800, height: 500 };

  it("does nothing while the cursor is inside the safe band", () => {
    expect(followVisible(zoomed, DISPLAY, { x: 800, y: 500 }, 0.18)).toBe(zoomed);
  });

  it("pans just enough to bring the cursor back to the band's edge", () => {
    // Inner band starts at 400 + 800*0.18 = 544. A cursor at 500 is 44 short: pan by -44.
    expect(followVisible(zoomed, DISPLAY, { x: 500, y: 500 }, 0.18)).toEqual({ ...zoomed, x: 356 });
  });

  it("is a no-op on an axis already showing the whole display", () => {
    const wide = { x: 0, y: 200, width: 1600, height: 400 };
    // Off to the left: nothing to pan to on that axis. Below the band: pans vertically only.
    expect(followVisible(wide, DISPLAY, { x: -50, y: 400 }, 0.18)).toBe(wide);
    expect(followVisible(wide, DISPLAY, { x: 800, y: 700 }, 0.18)).toEqual({ ...wide, y: 372 });
  });

  it("centres on a point as far as the display allows", () => {
    expect(centreVisible(zoomed, DISPLAY, { x: 800, y: 500 })).toEqual({ ...zoomed, x: 400, y: 250 });
    expect(centreVisible(zoomed, DISPLAY, { x: 10, y: 10 })).toEqual({ ...zoomed, x: 0, y: 0 });
  });
});

describe("fitRect", () => {
  it("letterboxes only when the size and the viewport disagree, which is the display's own edge", () => {
    // The whole 16:10 display in a square viewport: full width, bars top and bottom.
    expect(fitRect(DISPLAY, 800, 800)).toEqual({ x: 0, y: 150, width: 800, height: 500 });
    // A visible rect shaped to the viewport: the whole viewport.
    expect(fitRect({ width: 500, height: 200 }, 1000, 400)).toEqual({ x: 0, y: 0, width: 1000, height: 400 });
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
  const visible = { x: 400, y: 250, width: 800, height: 500 };
  const content = fitRect(visible, 800, 800);

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
    const whole = wholeDisplay(DISPLAY);
    const back = unprojectPoint({ x: 400, y: 0 }, whole, fitRect(whole, 800, 800), DISPLAY)!;
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

describe("a viewport whose aspect the display cannot hold at that size", () => {
  // A phone held upright, looking at a 16:9 desk.
  const desk = { width: 7680, height: 4320 };
  const phone = { width: 440, height: 878 };
  const aspect = phone.width / phone.height;

  it("keeps the viewport's aspect rather than filling one axis and letterboxing the other", () => {
    const zoomed = zoomVisible(wholeDisplay(desk), desk, 1.4, { x: 3840, y: 2160 }, phone);
    expect(zoomed.width / zoomed.height).toBeCloseTo(aspect, 3);
    expect(zoomed.height).toBeLessThanOrEqual(desk.height);
    const largest = largestFitting(desk, aspect);
    expect(zoomed.width).toBeCloseTo(largest.width, 6);
    expect(zoomed.height).toBeCloseTo(largest.height, 6);
  });

  it("goes from the largest rect that fills the viewport to the whole display, and no further", () => {
    const filling = zoomVisible(wholeDisplay(desk), desk, 1.4, { x: 3840, y: 2160 }, phone);
    const out = zoomVisible(filling, desk, 0.7, { x: 3840, y: 2160 }, phone);
    expect(isWholeDisplay(out, desk)).toBe(true);
    // And a pinch out from there stays there rather than coming back as a zoom in.
    expect(zoomVisible(out, desk, 0.7, { x: 3840, y: 2160 }, phone)).toEqual(out);
  });

  it("fills the viewport at every zoom deeper than that", () => {
    let visible = zoomVisible(wholeDisplay(desk), desk, 1.4, { x: 3840, y: 2160 }, phone);
    for (let step = 0; step < 6; step += 1) {
      visible = zoomVisible(visible, desk, 1.4, { x: visible.x, y: visible.y }, phone);
      expect(visible.width / visible.height).toBeCloseTo(aspect, 3);
    }
  });
});
