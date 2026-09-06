// The dock's own state, held outside React because the Feed re-renders too often to mount a
// terminal inside it. What is worth pinning is the two halves staying independent: the pane the
// Feed publishes, and the viewer's choice about whether a terminal is on screen.

import { beforeEach, describe, expect, it } from "vitest";
import { setTerminalDockPane, toggleTerminalDock } from "./terminalDockStore";

describe("the dock", () => {
  beforeEach(() => {
    localStorage.clear();
    setTerminalDockPane(null);
  });

  it("remembers being hidden, and being shown again", () => {
    // Read through a fresh import each time would be a different module instance, so the assertion
    // is on what was persisted -- which is what the next visit reads.
    toggleTerminalDock();
    expect(localStorage.getItem("agent-panel.terminal-dock")).toBe("hidden");
    toggleTerminalDock();
    expect(localStorage.getItem("agent-panel.terminal-dock")).toBe("shown");
  });

  it("takes a pane and gives it back, including the absence of one", () => {
    setTerminalDockPane("keyboard");
    setTerminalDockPane(null);
    // No throw and no persisted pane: which session is selected is not a preference, and a dock
    // that remembered one would attach to a pane the viewer is no longer looking at.
    expect(localStorage.getItem("agent-panel.terminal-dock")).toBe(null);
  });
});
