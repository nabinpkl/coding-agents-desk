import { describe, expect, it } from "vitest";
import {
  terminalChildSteps,
  terminalChildStyle,
  terminalParentHues,
  terminalParentStyle,
} from "@/features/terminal/terminalSurface";

describe("terminal parent hues", () => {
  it("ranks paths, not arrival order, so the same directory keeps its colour", () => {
    const first = terminalParentHues([
      { key: ":b", path: "/b" },
      { key: ":a", path: "/a" },
    ]);
    const second = terminalParentHues([
      { key: ":a", path: "/a" },
      { key: ":b", path: "/b" },
    ]);
    expect(first.get(":a")).toBe(second.get(":a"));
    expect(first.get(":a")).not.toBe(first.get(":b"));
  });

  it("keys the hue to machine:path, so one path on two machines wears two colours", () => {
    const hues = terminalParentHues([
      { key: ":proj", path: "/proj" },
      { key: "peer:proj", path: "/proj" },
    ]);
    expect(hues.get(":proj")).not.toBe(hues.get("peer:proj"));
  });

  it("hands CSS only the hue, under the terminal's own property name", () => {
    expect(terminalParentStyle(120)).toEqual({ "--terminal-hue": "120.00" });
    expect(terminalParentStyle(undefined)).toBeUndefined();
  });
});

describe("terminal child steps", () => {
  it("steps name order and cycles past six, the way the Bot ladder does", () => {
    const keys = ["b", "a", "c", "d", "e", "f", "g"].map((name) => `:${name}`);
    const steps = terminalChildSteps(keys);
    expect(steps.get(":a")).toBe(0);
    expect(steps.get(":b")).toBe(1);
    expect(steps.get(":g")).toBe(0);
  });

  it("hands CSS the parent hue and the child's own step, both or neither", () => {
    expect(terminalChildStyle(120, 2)).toEqual({
      "--terminal-hue": "120.00",
      "--terminal-session-step": "2",
      "--terminal-session-hue": "240.00",
    });
    expect(terminalChildStyle(undefined, 2)).toBeUndefined();
    expect(terminalChildStyle(120, undefined)).toBeUndefined();
  });
});
