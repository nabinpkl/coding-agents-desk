import { describe, expect, it } from "vitest";
import {
  capturePlanFor,
  leadPadding,
  paddedRegion,
  planServes,
  wantedPixelsPerPoint,
} from "@/features/desktop-viewer/zoom/tileCapturePlan";

const DISPLAY = { width: 7680, height: 4320 };

describe("wantedPixelsPerPoint", () => {
  it("asks for what the viewport can show", () => {
    expect(wantedPixelsPerPoint(1920, 1920, 1)).toBe(1);
    expect(wantedPixelsPerPoint(3840, 1920, 1)).toBe(0.5);
  });

  it("never asks for detail the display does not hold", () => {
    // A 1x virtual display has one pixel per point; zooming past it invents nothing.
    expect(wantedPixelsPerPoint(480, 1920, 1)).toBe(1);
    expect(wantedPixelsPerPoint(480, 1920, 2)).toBe(2);
  });
});

describe("paddedRegion", () => {
  it("captures beyond the visible area so a small pan needs no new capture", () => {
    expect(paddedRegion({ x: 1000, y: 1000, width: 1000, height: 1000 },
      DISPLAY.width, DISPLAY.height, 0.2))
      .toEqual({ x: 800, y: 800, width: 1400, height: 1400 });
  });

  it("never runs off the display", () => {
    const region = paddedRegion({ x: 0, y: 0, width: 7680, height: 4320 },
      DISPLAY.width, DISPLAY.height, 0.2);
    expect(region).toEqual({ x: 0, y: 0, width: 7680, height: 4320 });
  });
});

describe("capturePlanFor", () => {
  it("spends the viewport's pixels on the region, not on the whole display", () => {
    // Visible 1920 points in a 1920-pixel viewport wants one pixel per point; the padded region is
    // 20% larger each way, so it is captured at proportionally more pixels to hold that detail.
    const plan = capturePlanFor({ x: 2400, y: 1200, width: 1920, height: 1080 },
      DISPLAY.width, DISPLAY.height, 1920, 1);
    expect(plan.region.width).toBeCloseTo(2688, 6);
    expect(plan.pixelWidth).toBe(2688);
  });

  it("stops at the display's own resolution when zoomed past it", () => {
    // 480 visible points shown across 1920 pixels: the display holds 480 and that is what it gives.
    const plan = capturePlanFor({ x: 0, y: 0, width: 480, height: 270 },
      DISPLAY.width, DISPLAY.height, 1920, 1);
    expect(plan.pixelWidth).toBe(Math.round(plan.region.width) & ~1);
  });
});

describe("planServes", () => {
  const visible = { x: 2400, y: 1200, width: 1920, height: 1080 };
  const plan = capturePlanFor(visible, DISPLAY.width, DISPLAY.height, 1920, 1);

  it("keeps a plan that still covers the view at the detail it wants", () => {
    expect(planServes(plan, visible, 1)).toBe(true);
  });

  it("keeps a plan through a small pan, which is what the padding is for", () => {
    expect(planServes(plan, { ...visible, x: visible.x + 100 }, 1)).toBe(true);
  });

  it("re-aims once the view leaves the captured region", () => {
    expect(planServes(plan, { ...visible, x: visible.x + 900 }, 1)).toBe(false);
  });

  it("re-aims quickly when short of detail but tolerates a surplus", () => {
    // Wanting twice the detail this plan holds is blurred text: re-aim.
    expect(planServes(plan, visible, 2)).toBe(false);
    // Holding twice what is wanted only wastes encoder work: keep it.
    expect(planServes(plan, visible, 0.5)).toBe(true);
  });

  it("has nothing to serve with before a first capture", () => {
    expect(planServes(null, visible, 1)).toBe(false);
  });
});

describe("leadPadding", () => {
  const visible = { x: 3000, y: 2000, width: 1000, height: 1000 };

  it("spends the padding ahead of the motion and little behind", () => {
    const region = paddedRegion(visible, DISPLAY.width, DISPLAY.height, leadPadding({ x: 1, y: 0 }));
    // Moving right: 60% ahead on the right, 10% behind on the left, base on the still axis.
    expect(region.x).toBe(2900);
    expect(region.x + region.width).toBe(4600);
    expect(region.y).toBe(1800);
    expect(region.y + region.height).toBe(3200);
  });

  it("leans the other way for the other direction, on either axis", () => {
    const up = paddedRegion(visible, DISPLAY.width, DISPLAY.height, leadPadding({ x: 0, y: -1 }));
    expect(up.y).toBe(1400);
    expect(up.y + up.height).toBe(3100);
  });

  it("is plain symmetric padding when nothing is moving", () => {
    expect(leadPadding({ x: 0, y: 0 })).toEqual({ left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 });
  });
});
