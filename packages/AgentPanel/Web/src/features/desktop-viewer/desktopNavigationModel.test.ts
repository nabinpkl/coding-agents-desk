import { describe, expect, it } from "vitest";
import { initialNavigationModel, navigationGeometry, navigationReducer, navigationStep } from "@/features/desktop-viewer/desktopNavigationModel";

describe("desktop rail mechanics", () => {
  it("commits raw travel even when the visible rail would resist", () => {
    expect(navigationStep(-201, 0, 400, false)).toBe(1);
    expect(navigationStep(201, 0, 400, false)).toBe(-1);
    expect(navigationStep(201, 0, 400, true)).toBe(1);
    expect(navigationStep(-200, 0, 400, false)).toBe(0);
  });
  it("requires an agreeing flick and cancels a short reverse flick", () => {
    expect(navigationStep(-20, -801, 400, false)).toBe(1);
    expect(navigationStep(-20, 1200, 400, false)).toBe(0);
    expect(navigationStep(-220, 1200, 400, false)).toBe(1);
  });
  it("centers fits rows and clamps overflowing selections", () => {
    expect(navigationGeometry(2, 200, 0)).toMatchObject({ inset: 55, maximum: 0, offset: 0 });
    expect(navigationGeometry(10, 200, 9)).toMatchObject({ maximum: 290, offset: 290, indicatorLeft: 160 });
  });
  it("does not accept stale failures from a replaced request", () => {
    const state = navigationReducer(initialNavigationModel, { type: "pending", id: "new", target: "9", steps: 4 });
    expect(navigationReducer(state, { type: "failure", id: "old", reason: "timeout" })).toBe(state);
    expect(navigationReducer(state, { type: "failure", id: "new", reason: "timeout" }).motion.kind).toBe("idle");
  });
});
