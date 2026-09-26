/**
 * How the Father home stands, remembered across visits. Beside `botCanvasPreferences.test`
 * for the reason `fatherPreferences` is beside that file: one idea per file, on both sides
 * of the test boundary.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  FATHER_DEFAULT_HEIGHT,
  FATHER_DEFAULT_WIDTH,
  FATHER_MAX_HEIGHT,
  FATHER_MAX_WIDTH,
  FATHER_MIN_HEIGHT,
  FATHER_MIN_WIDTH,
  clampFatherHeight,
  clampFatherPosition,
  clampFatherWidth,
  loadFatherHeight,
  loadFatherOpen,
  loadFatherPosition,
  loadFatherWidth,
  storeFatherHeight,
  storeFatherOpen,
  storeFatherPosition,
  storeFatherWidth,
} from "@/features/bots/canvas/fatherPreferences";

describe("whether the Father home is open", () => {
  beforeEach(() => localStorage.clear());

  it("stays shut until a reader opens it, and forgets being open rather than storing false", () => {
    expect(loadFatherOpen()).toBe(false);
    storeFatherOpen(true);
    expect(loadFatherOpen()).toBe(true);
    expect(localStorage.getItem("agent-panel.bot-canvas.father-open")).toBe("true");
    storeFatherOpen(false);
    expect(loadFatherOpen()).toBe(false);
    expect(localStorage.getItem("agent-panel.bot-canvas.father-open")).toBeNull();
  });
});

describe("how tall the Father home stands", () => {
  beforeEach(() => localStorage.clear());

  it("opens at its default height and holds a drag inside its own range", () => {
    expect(loadFatherHeight()).toBe(FATHER_DEFAULT_HEIGHT);
    storeFatherHeight(400);
    expect(loadFatherHeight()).toBe(400);
    storeFatherHeight(10);
    expect(loadFatherHeight()).toBe(FATHER_MIN_HEIGHT);
    storeFatherHeight(99999);
    expect(loadFatherHeight()).toBe(FATHER_MAX_HEIGHT);
    expect(clampFatherHeight(Number.NaN)).toBe(FATHER_DEFAULT_HEIGHT);
  });

  it("forgets a default height and refuses a value it cannot read", () => {
    storeFatherHeight(400);
    storeFatherHeight(FATHER_DEFAULT_HEIGHT);
    expect(localStorage.getItem("agent-panel.bot-canvas.father-height")).toBeNull();
    localStorage.setItem("agent-panel.bot-canvas.father-height", "tall");
    expect(loadFatherHeight()).toBe(FATHER_DEFAULT_HEIGHT);
  });
});

describe("how wide the Father home stands", () => {
  beforeEach(() => localStorage.clear());

  it("opens at the width it always drew at, and holds a drag inside its own range", () => {
    expect(loadFatherWidth()).toBe(FATHER_DEFAULT_WIDTH);
    storeFatherWidth(1000);
    expect(loadFatherWidth()).toBe(1000);
    storeFatherWidth(10);
    expect(loadFatherWidth()).toBe(FATHER_MIN_WIDTH);
    storeFatherWidth(99999);
    expect(loadFatherWidth()).toBe(FATHER_MAX_WIDTH);
    expect(clampFatherWidth(Number.NaN)).toBe(FATHER_DEFAULT_WIDTH);
  });

  it("forgets a default width and refuses a value it cannot read", () => {
    storeFatherWidth(1000);
    storeFatherWidth(FATHER_DEFAULT_WIDTH);
    expect(localStorage.getItem("agent-panel.bot-canvas.father-width")).toBeNull();
    localStorage.setItem("agent-panel.bot-canvas.father-width", "wide");
    expect(loadFatherWidth()).toBe(FATHER_DEFAULT_WIDTH);
  });
});

describe("where the Father drawer stands", () => {
  beforeEach(() => localStorage.clear());

  it("stands centered top until first carried, then remembers the stand", () => {
    expect(loadFatherPosition()).toBeNull();
    storeFatherPosition({ x: 300, y: 40 });
    expect(loadFatherPosition()).toEqual({ x: 300, y: 40 });
    expect(localStorage.getItem("agent-panel.bot-canvas.father-position")).toBe(
      JSON.stringify({ x: 300, y: 40 }),
    );
  });

  it("refuses a stand it cannot read rather than stranding the drawer", () => {
    localStorage.setItem("agent-panel.bot-canvas.father-position", "centered");
    expect(loadFatherPosition()).toBeNull();
    localStorage.setItem("agent-panel.bot-canvas.father-position", JSON.stringify({ x: 300 }));
    expect(loadFatherPosition()).toBeNull();
    localStorage.setItem(
      "agent-panel.bot-canvas.father-position",
      JSON.stringify({ x: Number.NaN, y: 40 }),
    );
    expect(loadFatherPosition()).toBeNull();
  });

  it("keeps a strip of the drawer on screen whatever the drag or window does", () => {
    const size = { width: 880, height: 480 };
    const viewport = { width: 1440, height: 900 };
    expect(clampFatherPosition({ x: 300, y: 40 }, size, viewport)).toEqual({ x: 300, y: 40 });
    // Past the right and bottom edges comes back to a grabbable strip.
    expect(clampFatherPosition({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 1320, y: 820 });
    // Past the left and top edges likewise, and a window narrower than the margin still
    // leaves the drawer reachable rather than clamping to a negative gutter.
    expect(clampFatherPosition({ x: -5000, y: -50 }, size, viewport)).toEqual({ x: -760, y: 0 });
    expect(clampFatherPosition({ x: 0, y: 0 }, size, { width: 80, height: 60 })).toEqual({ x: 0, y: 0 });
  });
});
