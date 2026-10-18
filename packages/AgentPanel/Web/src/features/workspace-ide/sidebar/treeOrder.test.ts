import { describe, expect, it } from "vitest";
import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { isTreeOrder, sortSiblings } from "@/features/workspace-ide/sidebar/treeOrder";

function node(name: string, isDirectory: boolean, modifiedAt: number): WorkspaceTreeNode {
  return {
    name,
    path: name,
    isDirectory,
    expanded: false,
    gitStatus: null,
    modifiedAt,
    children: [],
  };
}

// Arrived in the order the sidecar sends them: folders first, then names.
const PROJECTION = [
  node("src", true, 100),
  node("assets", true, 300),
  node("README.md", false, 200),
  node("main.ts", false, 400),
];

describe("sortSiblings", () => {
  it("leaves the name order exactly as it arrived", () => {
    // Not a re-sort with the same answer: the sidecar owns that collation, and a second copy of it
    // in the browser is a second answer to the same question.
    expect(sortSiblings(PROJECTION, "name").map((entry) => entry.name)).toEqual([
      "src",
      "assets",
      "README.md",
      "main.ts",
    ]);
  });

  it("puts the most recently changed first, folders still above files", () => {
    expect(sortSiblings(PROJECTION, "modified").map((entry) => entry.name)).toEqual([
      "assets",
      "src",
      "main.ts",
      "README.md",
    ]);
  });

  it("keeps entries that share a timestamp in the order they arrived", () => {
    const same = [node("b.ts", false, 500), node("a.ts", false, 500), node("c.ts", false, 500)];
    expect(sortSiblings(same, "modified").map((entry) => entry.name)).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("sorts an entry nothing can be dated for to the bottom of its group", () => {
    // A file that went away between the listing and the stat has no date to compare, and 0 is older
    // than anything real.
    const gone = [node("known.ts", false, 500), node("unknown.ts", false, 0)];
    expect(sortSiblings(gone, "modified").map((entry) => entry.name)).toEqual(["known.ts", "unknown.ts"]);
  });

  it("does not touch the array it was handed", () => {
    const rows = [...PROJECTION];
    sortSiblings(rows, "modified");
    expect(rows.map((entry) => entry.name)).toEqual(["src", "assets", "README.md", "main.ts"]);
  });

  it("has nothing to reorder in an empty directory", () => {
    expect(sortSiblings([], "modified")).toEqual([]);
  });
});

describe("isTreeOrder", () => {
  it("takes the two orders and refuses anything else", () => {
    expect(isTreeOrder("name")).toBe(true);
    expect(isTreeOrder("modified")).toBe(true);
    expect(isTreeOrder("Modified")).toBe(false);
    expect(isTreeOrder(null)).toBe(false);
  });
});
