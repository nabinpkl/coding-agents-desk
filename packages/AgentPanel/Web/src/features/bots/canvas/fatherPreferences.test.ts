/**
 * How the Father home stands, remembered across visits. Beside `botCanvasPreferences.test`
 * for the reason `fatherPreferences` is beside that file: one idea per file, on both sides
 * of the test boundary.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FATHER_WINDOW, loadFatherOpen, storeFatherOpen } from "@/features/bots/canvas/fatherPreferences";

const FATHER_DEFAULT_HEIGHT = 480;
const FATHER_MIN_HEIGHT = 160;
const FATHER_MAX_HEIGHT = 640;
const FATHER_DEFAULT_WIDTH = 880;
const FATHER_MIN_WIDTH = 480;
const FATHER_MAX_WIDTH = 1200;
const {
  clampHeight: clampFatherHeight,
  clampWidth: clampFatherWidth,
  loadHeight: loadFatherHeight,
  loadWidth: loadFatherWidth,
  loadPosition: loadFatherPosition,
  storeHeight: storeFatherHeight,
  storeWidth: storeFatherWidth,
  storePosition: storeFatherPosition,
} = FATHER_WINDOW;

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
    expect(localStorage.getItem("agent-panel.bot-canvas.father-position")).toBe(JSON.stringify({ x: 300, y: 40 }));
  });

  it("refuses a stand it cannot read rather than stranding the drawer", () => {
    localStorage.setItem("agent-panel.bot-canvas.father-position", "centered");
    expect(loadFatherPosition()).toBeNull();
    localStorage.setItem("agent-panel.bot-canvas.father-position", JSON.stringify({ x: 300 }));
    expect(loadFatherPosition()).toBeNull();
    localStorage.setItem("agent-panel.bot-canvas.father-position", JSON.stringify({ x: Number.NaN, y: 40 }));
    expect(loadFatherPosition()).toBeNull();
  });
});
