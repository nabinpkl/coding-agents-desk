import { describe, expect, it } from "vitest";
import { VelocityTracker } from "@/features/desktop-viewer/pointer-input/velocityTracker";

describe("VelocityTracker", () => {
  it("is still until it has two samples", () => {
    const tracker = new VelocityTracker();
    expect(tracker.velocity()).toEqual({ x: 0, y: 0 });
    tracker.add(10, 10, 0);
    expect(tracker.velocity()).toEqual({ x: 0, y: 0 });
  });

  it("averages over the window, so one uneven step does not decide it", () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0, 0);
    tracker.add(10, 0, 10);
    tracker.add(20, 0, 20);
    // A jittery last step: 30px in 2ms reads as 15000 px/s on its own.
    tracker.add(50, 0, 22);
    expect(tracker.velocity().x).toBeCloseTo(50 / 0.022);
  });

  it("forgets samples older than the window", () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0, 0);
    tracker.add(1_000, 0, 50);
    tracker.add(1_000, 0, 300);
    tracker.add(1_010, 0, 400);
    // The fast travel at 50ms is out of the window; what remains is 10px over 100ms.
    expect(tracker.velocity().x).toBeCloseTo(100);
  });
});
