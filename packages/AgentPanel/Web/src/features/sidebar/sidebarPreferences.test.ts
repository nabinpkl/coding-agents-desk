import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  loadSidebarPreferences,
  storeSidebarPreferences,
} from "./sidebarPreferences";

describe("sidebar preferences", () => {
  beforeEach(() => localStorage.clear());

  it("opens at the default width before a preference is saved", () => {
    expect(loadSidebarPreferences()).toEqual(DEFAULT_SIDEBAR_PREFERENCES);
  });

  it("restores a saved open state and width", () => {
    storeSidebarPreferences({ open: false, width: 336 });
    expect(loadSidebarPreferences()).toEqual({ open: false, width: 336 });
  });

  it("validates stale fields independently", () => {
    localStorage.setItem("agent-panel.sidebar.preferences", JSON.stringify({
      open: "yes",
      width: 9999,
    }));
    expect(loadSidebarPreferences()).toEqual(DEFAULT_SIDEBAR_PREFERENCES);
  });

  it("clamps widths before storing them", () => {
    storeSidebarPreferences({ open: true, width: 1 });
    expect(loadSidebarPreferences().width).toBe(MIN_SIDEBAR_WIDTH);

    storeSidebarPreferences({ open: true, width: 9999 });
    expect(loadSidebarPreferences().width).toBe(MAX_SIDEBAR_WIDTH);
  });
});
