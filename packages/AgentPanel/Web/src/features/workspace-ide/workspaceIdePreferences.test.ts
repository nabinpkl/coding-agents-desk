import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_IDE_PREFERENCES,
  clampFraction,
  loadWorkspaceIdePreferences,
  SIDEBAR_FRACTION_RANGE,
  storeWorkspaceIdePreferences,
} from "@/features/workspace-ide/workspaceIdePreferences";

const KEY = "agent-panel.workspace-ide.preferences";

beforeEach(() => localStorage.clear());

describe("clampFraction", () => {
  it("holds a fraction inside its range", () => {
    expect(clampFraction(0.3, SIDEBAR_FRACTION_RANGE)).toBe(0.3);
    expect(clampFraction(0.9, SIDEBAR_FRACTION_RANGE)).toBe(SIDEBAR_FRACTION_RANGE[1]);
    expect(clampFraction(0, SIDEBAR_FRACTION_RANGE)).toBe(SIDEBAR_FRACTION_RANGE[0]);
  });

  it("treats a value that is not a number as the low end, not as NaN", () => {
    expect(clampFraction(Number.NaN, SIDEBAR_FRACTION_RANGE)).toBe(SIDEBAR_FRACTION_RANGE[0]);
    expect(clampFraction(Number.POSITIVE_INFINITY, SIDEBAR_FRACTION_RANGE)).toBe(SIDEBAR_FRACTION_RANGE[0]);
  });
});

describe("loadWorkspaceIdePreferences", () => {
  it("is the default with nothing stored", () => {
    expect(loadWorkspaceIdePreferences()).toEqual(DEFAULT_WORKSPACE_IDE_PREFERENCES);
  });

  it("round-trips what was stored", () => {
    const stored = {
      ...DEFAULT_WORKSPACE_IDE_PREFERENCES,
      workspaceId: "w-1",
      activePathByWorkspace: { "w-1": "src/main.ts" },
      fileViewByWorkspace: {
        "w-1": { "README.md": "source" as const, "notes.txt": "preview" as const },
      },
      section: "sourceControl" as const,
      treeOrder: "modified" as const,
      terminalVisible: true,
      sidebarFraction: 0.3,
    };
    storeWorkspaceIdePreferences(stored);
    expect(loadWorkspaceIdePreferences()).toEqual(stored);
  });

  it("falls back per field rather than casting a hand-edited shape", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        workspaceId: 42,
        activePathByWorkspace: { "w-1": 7, "w-2": "ok.ts" },
        fileViewByWorkspace: {
          "w-1": { "a.md": "source", "b.md": "rendered", "c.md": 3 },
          "w-2": "not-a-record",
        },
        section: "invented",
        treeOrder: "by-vibes",
        sidebarFraction: "wide",
        terminalFraction: 99,
      }),
    );
    expect(loadWorkspaceIdePreferences()).toEqual({
      ...DEFAULT_WORKSPACE_IDE_PREFERENCES,
      workspaceId: null,
      activePathByWorkspace: { "w-2": "ok.ts" },
      // "rendered" is not one of the two words, so it is dropped rather than becoming a view that
      // nothing renders; "w-2" is not a record at all and never reaches the result.
      fileViewByWorkspace: { "w-1": { "a.md": "source" } },
      section: "explorer",
      // An order nobody can draw is the default order, rather than a third order the tree would
      // have to know about.
      treeOrder: "name",
      terminalFraction: 0.7,
    });
  });

  it("survives a value that is not JSON at all", () => {
    localStorage.setItem(KEY, "{{{");
    expect(loadWorkspaceIdePreferences()).toEqual(DEFAULT_WORKSPACE_IDE_PREFERENCES);
  });
});
