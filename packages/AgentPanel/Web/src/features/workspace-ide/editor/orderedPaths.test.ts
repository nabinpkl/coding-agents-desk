import { describe, expect, it } from "vitest";
import { orderedPathsAfterMove } from "@/features/workspace-ide/editor/orderedPaths";

describe("orderedPathsAfterMove", () => {
  const paths = ["a.ts", "b.ts", "c.ts"];

  it("moves a tab to where it was dropped", () => {
    expect(orderedPathsAfterMove(paths, "a.ts", "c.ts")).toEqual(["b.ts", "c.ts", "a.ts"]);
    expect(orderedPathsAfterMove(paths, "c.ts", "a.ts")).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("leaves the order alone when a tab is dropped on itself", () => {
    expect(orderedPathsAfterMove(paths, "b.ts", "b.ts")).toEqual(paths);
  });

  it("returns a permutation, never an invented order, for a path it does not hold", () => {
    expect(orderedPathsAfterMove(paths, "z.ts", "a.ts")).toEqual(paths);
    expect(orderedPathsAfterMove(paths, "a.ts", "z.ts")).toEqual(paths);
  });

  it("does not mutate the list it was given", () => {
    const original = [...paths];
    orderedPathsAfterMove(paths, "a.ts", "c.ts");
    expect(paths).toEqual(original);
  });
});
