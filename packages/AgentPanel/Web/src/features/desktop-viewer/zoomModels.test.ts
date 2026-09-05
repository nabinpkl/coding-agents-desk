import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOverviewReady, getCaptureCrop, markOverviewReady, setCaptureCrop } from "./captureCrop";
import { createZoomView } from "./zoomModels";

const DISPLAY = { width: 1600, height: 1000 };
const W = 800;
const H = 500;

function box() {
  const inner = document.createElement("div");
  return inner;
}
const layers = (content: HTMLElement) => ({ content, underlay: null });

describe("crop zoom view", () => {
  beforeEach(() => {
    setCaptureCrop(null);
    clearOverviewReady();
  });

  it("re-places the frame already on screen the moment the view zooms, before any new capture", () => {
    const view = createZoomView("crop", DISPLAY);
    const inner = box();
    view.paint(layers(inner), W, H);
    expect(inner.style.width).toBe("800px");
    // Zoom 2x about the top-left corner: the same whole-display frame is now drawn twice as large,
    // anchored there, so what the viewport shows is the top-left quarter -- sharp arrives later.
    view.zoomAt(2, 0, 0, W, H);
    view.paint(layers(inner), W, H);
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
    view.paint(layers(inner), W, H);
    expect(inner.style.width).toBe("1600px");
    view.applied(plan);
    view.paint(layers(inner), W, H);
    expect(inner.style.width).toBe("1120px");
    expect(inner.style.left).toBe("-160px");
  });

  it("returns to the whole display, and says so, on reset", () => {
    const view = createZoomView("crop", DISPLAY);
    view.zoomAt(3, 100, 100, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).not.toBeNull();
    view.applied(getCaptureCrop());
    view.reset();
    view.settle(W, H);
    expect(getCaptureCrop()).toBeNull();
    expect(view.isZoomed()).toBe(false);
  });

  it("holds one re-aim in flight and honours the latest view once it lands", () => {
    // A second request during a negotiation would tear the first down before it painted, which
    // is the teardown race ScreenCaptureKit starves on. So the second waits for the first.
    const view = createZoomView("crop", DISPLAY);
    view.zoomAt(2, W / 2, H / 2, W, H);
    view.settle(W, H);
    const first = getCaptureCrop();
    view.zoomAt(2, W / 2, H / 2, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).toBe(first);
    view.applied(first);
    // Zoomed further in, the first plan still covers the view at the display's own detail, so it
    // is kept; that is the surplus tolerance, not the hold. Leaving its region is what re-aims.
    view.settle(W, H);
    expect(getCaptureCrop()).toBe(first);
    view.panBy(800, 0, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).not.toBe(first);
    expect(getCaptureCrop()!.region.x).toBeLessThan(first!.region.x);
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
    view.paint(layers(inner), W, H);
    expect(inner.style.transform).toContain("scale(2)");
    expect(inner.style.position).toBe("");
    view.dispose(layers(inner));
    expect(inner.style.transform).toBe("");
  });
});

describe("crop zoom view with an overview underneath", () => {
  beforeEach(() => {
    setCaptureCrop(null);
    clearOverviewReady();
  });

  it("asks for no sharp capture while the overview already has the detail the view can show", () => {
    // In an 800px-wide viewport the overview of a 1600-point display holds 0.5 px/pt. Zoomed to
    // 1500 points wide the view wants 0.53, within 8% of that: no second stream.
    const view = createZoomView("crop", DISPLAY, { overview: true });
    markOverviewReady(performance.now() - 1000);
    view.zoomAt(1600 / 1500, W / 2, H / 2, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).toBeNull();
  });

  it("holds the sharp request until the overview has been painting for a moment", () => {
    const view = createZoomView("crop", DISPLAY, { overview: true });
    view.zoomAt(3, W / 2, H / 2, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).toBeNull();
    markOverviewReady(performance.now() - 1000);
    view.settle(W, H);
    expect(getCaptureCrop()).not.toBeNull();
  });

  it("comes back sharp after a zoom out: a null plan under the overview waits for nothing", () => {
    const view = createZoomView("crop", DISPLAY, { overview: true });
    markOverviewReady(performance.now() - 1000);
    view.zoomAt(3, W / 2, H / 2, W, H);
    view.settle(W, H);
    view.applied(getCaptureCrop());
    view.reset();
    view.settle(W, H);
    expect(getCaptureCrop()).toBeNull();
    // Nothing answers a null plan, so the next settle must not be held waiting for it.
    view.zoomAt(3, W / 2, H / 2, W, H);
    view.settle(W, H);
    expect(getCaptureCrop()).not.toBeNull();
  });

  it("ignores a plan the store still holds for another display", () => {
    setCaptureCrop({
      display: { width: 4000, height: 3000 },
      region: { x: 0, y: 500, width: 600, height: 400 },
      pixelWidth: 600,
      pixelHeight: 400,
    });
    const view = createZoomView("crop", DISPLAY, { overview: true });
    const content = box();
    const underlay = box();
    view.paint({ content, underlay }, W, H);
    // Placed as the whole display, not as the other display's crop.
    expect(content.style.width).toBe("800px");
    expect(content.style.left).toBe("0px");
  });

  it("stops waiting on a plan whose stream never paints, so the view can aim somewhere useful", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const view = createZoomView("crop", DISPLAY, { overview: true });
      markOverviewReady(performance.now() - 1000);
      view.zoomAt(3, W / 2, H / 2, W, H);
      view.settle(W, H);
      const requested = getCaptureCrop();
      expect(requested).not.toBeNull();
      // The stream for it never arrives, and the view moves off the region it would have covered.
      view.panBy(-2000, 0, W, H);
      expect(view.settle(W, H).outcome).toBe("awaiting");
      vi.advanceTimersByTime(3_000);
      expect(view.settle(W, H).outcome).toBe("planned");
      expect(getCaptureCrop()).not.toBe(requested);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the sharp frame only when it covers the view, and the coarse one always", () => {
    const view = createZoomView("crop", DISPLAY, { overview: true });
    markOverviewReady(performance.now() - 1000);
    const content = box();
    const underlay = box();
    view.zoomAt(3, W / 2, H / 2, W, H);
    view.settle(W, H);
    view.applied(getCaptureCrop());
    view.paint({ content, underlay }, W, H);
    expect(content.style.visibility).toBe("");
    expect(underlay.style.visibility).toBe("");
    // Pan well past the padded region: the sharp frame no longer covers the view, so it is
    // hidden and the coarse one is what shows, rather than a seam sweeping across.
    view.panBy(-2000, 0, W, H);
    view.paint({ content, underlay }, W, H);
    expect(content.style.visibility).toBe("hidden");
    expect(underlay.style.visibility).toBe("");
  });
});
