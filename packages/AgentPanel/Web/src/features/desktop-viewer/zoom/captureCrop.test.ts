import { beforeEach, describe, expect, it } from "vitest";
import {
  captureCropApplied,
  getCaptureCrop,
  onCaptureCropApplied,
  setCaptureCrop,
} from "@/features/desktop-viewer/zoom/captureCrop";

const plan = (x: number) => ({
  display: { width: 1920, height: 1080 },
  region: { x, y: 20, width: 640, height: 480 },
  pixelWidth: 640,
  pixelHeight: 480,
});

describe("captureCrop", () => {
  beforeEach(() => setCaptureCrop(null));

  it("starts as the whole display", () => {
    expect(getCaptureCrop()).toBeNull();
  });

  it("treats sub-pixel drift as the same plan, since display points are whole", () => {
    setCaptureCrop(plan(10));
    const before = getCaptureCrop();
    setCaptureCrop({ ...plan(10), region: { x: 10.4, y: 19.6, width: 640.2, height: 480.4 } });
    expect(getCaptureCrop()).toBe(before);
  });

  it("announces the plan that is on screen once its first frame lands", () => {
    const seen: unknown[] = [];
    const stop = onCaptureCropApplied((applied) => seen.push(applied));
    setCaptureCrop(plan(10));
    expect(seen).toEqual([]);
    captureCropApplied();
    expect(seen).toEqual([plan(10)]);
    stop();
    captureCropApplied();
    expect(seen).toHaveLength(1);
  });
});
