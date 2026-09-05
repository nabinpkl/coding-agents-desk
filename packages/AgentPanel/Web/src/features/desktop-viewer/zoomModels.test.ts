import { beforeEach, describe, expect, it } from "vitest";
import { getCaptureCrop, setCaptureCrop } from "./captureCrop";
import { createZoomView } from "./zoomModels";

const DISPLAY = { width: 1600, height: 1000 };
const W = 800;
const H = 500;

function box() {
  const inner = document.createElement("div");
  return inner;
}

describe("crop zoom view", () => {
  beforeEach(() => setCaptureCrop(null));

  it("re-places the frame already on screen the moment the view zooms, before any new capture", () => {
    const view = createZoomView("crop", DISPLAY);
    const inner = box();
    view.paint(inner, W, H);
    expect(inner.style.width).toBe("800px");
    // Zoom 2x about the top-left corner: the same whole-display frame is now drawn twice as large,
    // anchored there, so what the viewport shows is the top-left quarter -- sharp arrives later.
    view.zoomAt(2, 0, 0, W, H);
    view.paint(inner, W, H);
    expect(inner.style.left).toBe("0px");
    expect(inner.style.width).toBe("1600px");
    expect(inner.style.height).toBe("1000px");
  });

  it("asks for a padded plan on settle and places the frame by it once applied", () => {
    const view = createZoomView("crop", DISPLAY);
    view.zoomAt(2, W / 2, H / 2, W, H);
    view.settle(W, H);
    const plan = getCaptureCrop();
    expect(plan).not.toBeNull();
    // Centre zoom 2x shows the middle 800x500; the plan pads that by 20% each way.
    expect(plan!.region.width).toBeCloseTo(1120, 6);
    expect(plan!.region.x).toBeCloseTo(240, 6);
    // Until the plan's first frame lands, the frame on screen still covers the whole display and
    // is placed as such; afterwards it covers the region and is placed to match.
    const inner = box();
    view.paint(inner, W, H);
    expect(inner.style.width).toBe("1600px");
    view.applied(plan);
    view.paint(inner, W, H);
    expect(inner.style.width).toBe("1120px");
    expect(inner.style.left).toBe("-160px");
  });

  it("returns to the whole display, and says so, on reset", () => {
    const view = createZoomView("crop", DISPLAY);
    view.zoomAt(3, 100, 100, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).not.toBeNull();
    view.reset();
    view.settle(W, H);
    expect(getCaptureCrop()).toBeNull();
    expect(view.isZoomed()).toBe(false);
  });

  it("pans in display points against the gesture's pixels, so a drag moves the view the other way", () => {
    const view = createZoomView("crop", DISPLAY);
    view.zoomAt(2, W / 2, H / 2, W, H);
    const before = view.telemetry();
    // Dragging the content 100px to the right reveals what is to the left: the view moves left.
    view.panBy(100, 0, W, H);
    expect(view.telemetry().tx).toBeLessThan(before.tx);
  });
});

describe("css zoom view", () => {
  it("paints a transform and nothing else, and leaves nothing behind", () => {
    const view = createZoomView("css", DISPLAY);
    const inner = box();
    view.zoomAt(2, 0, 0, W, H);
    view.paint(inner, W, H);
    expect(inner.style.transform).toContain("scale(2)");
    expect(inner.style.position).toBe("");
    view.dispose(inner);
    expect(inner.style.transform).toBe("");
  });
});
