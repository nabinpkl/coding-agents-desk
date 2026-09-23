import { beforeEach, describe, expect, it } from "vitest";
import {
  loadHiddenTerminalParents,
  loadOffStripTerminalChildren,
  loadOpenTerminalChildren,
  loadTerminalActiveOnly,
  loadTerminalRoom,
  loadTerminalZoomMode,
  loadTerminalZoomScale,
  storeHiddenTerminalParents,
  storeOffStripTerminalChildren,
  storeOpenTerminalChildren,
  storeTerminalActiveOnly,
  storeTerminalRoom,
  storeTerminalZoomMode,
  storeTerminalZoomScale,
} from "@/features/terminal/canvas/terminalCanvasPreferences";

describe("terminal canvas preferences", () => {
  beforeEach(() => localStorage.clear());

  it("knows nothing before the reader has arranged anything", () => {
    expect(loadHiddenTerminalParents()).toEqual(new Set());
    expect(loadOffStripTerminalChildren()).toEqual(new Set());
    expect(loadOpenTerminalChildren()).toEqual(new Set());
  });

  it("remembers hidden parents, off-strip children and open children by their keys", () => {
    storeHiddenTerminalParents(new Set([":/proj", "peer:/other"]));
    storeOffStripTerminalChildren(new Set([":a", "peer:b"]));
    storeOpenTerminalChildren(new Set([":a"]));
    expect(loadHiddenTerminalParents()).toEqual(new Set([":/proj", "peer:/other"]));
    expect(loadOffStripTerminalChildren()).toEqual(new Set([":a", "peer:b"]));
    expect(loadOpenTerminalChildren()).toEqual(new Set([":a"]));
  });

  it("drops a hand-edited entry without costing the ones beside it", () => {
    localStorage.setItem("agent-panel.terminal-canvas.off-strip-children", JSON.stringify([":a", "no-colon", ":a:1.x", ":"]));
    expect(loadOffStripTerminalChildren()).toEqual(new Set([":a"]));
    // A second colon is a window key now, not hand-edited: sessions keep their own rows.
    localStorage.setItem("agent-panel.terminal-canvas.open-children", JSON.stringify([":harbor:1", ":harbor:1.2"]));
    expect(loadOpenTerminalChildren()).toEqual(new Set([":harbor:1", ":harbor:1.2"]));
    localStorage.setItem("agent-panel.terminal-canvas.open-children", JSON.stringify("not-an-array"));
    expect(loadOpenTerminalChildren()).toEqual(new Set());
    localStorage.setItem("agent-panel.terminal-canvas.hidden-parents", JSON.stringify(["", ":/proj"]));
    expect(loadHiddenTerminalParents()).toEqual(new Set([":/proj"]));
  });

  it("removes the key when the set empties, rather than storing an empty array", () => {
    storeOpenTerminalChildren(new Set([":a"]));
    storeOpenTerminalChildren(new Set());
    expect(localStorage.getItem("agent-panel.terminal-canvas.open-children")).toBeNull();
  });

  it("keeps its own zoom and room keys, never the Bot canvas's", () => {
    expect(loadTerminalZoomMode()).toBe(false);
    expect(loadTerminalZoomScale()).toBe(0.02);
    expect(loadTerminalRoom()).toBe(0);
    storeTerminalZoomMode(true);
    storeTerminalZoomScale(0.5);
    storeTerminalRoom(64);
    expect(loadTerminalZoomMode()).toBe(true);
    expect(loadTerminalZoomScale()).toBe(0.5);
    expect(loadTerminalRoom()).toBe(64);
    expect(localStorage.getItem("agent-panel.terminal-canvas.zoom-mode")).toBe("on");
    expect(localStorage.getItem("agent-panel.bot-canvas.zoom-mode")).toBeNull();
    storeTerminalZoomMode(false);
    expect(localStorage.getItem("agent-panel.terminal-canvas.zoom-mode")).toBeNull();
  });

  it("drops a hand-edited zoom scale and room back to the fit defaults", () => {
    localStorage.setItem("agent-panel.terminal-canvas.zoom-scale", JSON.stringify("wide"));
    localStorage.setItem("agent-panel.terminal-canvas.room", JSON.stringify(999));
    expect(loadTerminalZoomScale()).toBe(0.02);
    expect(loadTerminalRoom()).toBe(0);
  });

  it("opens showing everything, remembering only an explicit active-only choice", () => {
    expect(loadTerminalActiveOnly()).toBe(false);
    storeTerminalActiveOnly(true);
    expect(loadTerminalActiveOnly()).toBe(true);
    expect(localStorage.getItem("agent-panel.terminal-canvas.active-only")).toBe("on");
    storeTerminalActiveOnly(false);
    expect(loadTerminalActiveOnly()).toBe(false);
    expect(localStorage.getItem("agent-panel.terminal-canvas.active-only")).toBeNull();
  });
});
