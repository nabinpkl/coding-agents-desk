import { beforeEach, describe, expect, it } from "vitest";
import { clampFloatingPosition, clampFloatingTop, floatingWindowPreferences } from "@/features/floating-window/floatingWindowPreferences";

describe("where a floating window may stand", () => {
  it("keeps a strip of a window on screen whatever the drag or window does", () => {
    const size = { width: 880, height: 480 };
    const viewport = { width: 1440, height: 900 };
    expect(clampFloatingPosition({ x: 300, y: 40 }, size, viewport)).toEqual({ x: 300, y: 40 });
    // Past the right and bottom edges comes back to a grabbable strip.
    expect(clampFloatingPosition({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 1320, y: 820 });
    // Past the left and top edges likewise, and a window narrower than the margin still
    // leaves the drawer reachable rather than clamping to a negative gutter.
    expect(clampFloatingPosition({ x: -5000, y: -50 }, size, viewport)).toEqual({ x: -760, y: 0 });
    expect(clampFloatingPosition({ x: 0, y: 0 }, size, { width: 80, height: 60 })).toEqual({ x: 0, y: 0 });
  });

  it("holds a resting place low enough to leave a strip of the window on screen", () => {
    expect(clampFloatingTop(60, 900)).toBe(60);
    expect(clampFloatingTop(900, 600)).toBe(520);
    expect(clampFloatingTop(-10, 600)).toBe(0);
  });
});

describe("one window's memory", () => {
  beforeEach(() => localStorage.clear());

  it("keeps each window under its own keys and in its own range", () => {
    const judge = floatingWindowPreferences("test.judge", {
      width: { min: 300, max: 900, default: 600 },
      height: { min: 200, max: 700, default: 500 },
    });
    const other = floatingWindowPreferences("test.other", {
      width: { min: 300, max: 900, default: 400 },
      height: { min: 200, max: 700, default: 300 },
    });
    judge.storeWidth(720);
    judge.storePosition({ x: 10.4, y: 20.6 });
    expect(localStorage.getItem("test.judge-width")).toBe("720");
    expect(judge.loadPosition()).toEqual({ x: 10, y: 21 });
    expect(other.loadWidth()).toBe(400);
    expect(other.loadPosition()).toBeNull();
    judge.storeHeight(5000);
    expect(judge.loadHeight()).toBe(700);
  });
});
