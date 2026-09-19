import { beforeEach, describe, expect, it } from "vitest";
import {
  loadHiddenTerminalParents,
  loadOffStripTerminalChildren,
  loadOpenTerminalChildren,
  storeHiddenTerminalParents,
  storeOffStripTerminalChildren,
  storeOpenTerminalChildren,
} from "@/features/terminal/terminalCanvasPreferences";

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
    localStorage.setItem("agent-panel.terminal-canvas.off-strip-children", JSON.stringify([":a", "no-colon", "a:b:c", ":"]));
    expect(loadOffStripTerminalChildren()).toEqual(new Set([":a"]));
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
});
