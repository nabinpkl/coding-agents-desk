import { describe, expect, it } from "vitest";
import {
  terminalChildSteps,
  terminalChildStyle,
  terminalParentHues,
  terminalParentRanks,
  terminalParentStyle,
} from "@/features/terminal/canvas/terminalSurface";

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

  it("ranks the same path order the hues colour by, so a face keeps its colour", () => {
    const parents = [
      { key: ":b", path: "/b" },
      { key: ":a", path: "/a" },
    ];
    const ranks = terminalParentRanks(parents);
    expect(ranks.get(":a")).toBe(0);
    expect(ranks.get(":b")).toBe(1);
    expect(ranks.get(":a")).not.toBe(ranks.get(":b"));
  });
});

describe("terminal child steps", () => {
  it("ranks name order whole, and the ladder cycles past six the way the Bot ladder does", () => {
    const keys = ["b", "a", "c", "d", "e", "f", "g"].map((name) => `:${name}`);
    const steps = terminalChildSteps(keys);
    expect(steps.get(":a")).toBe(0);
    expect(steps.get(":b")).toBe(1);
    expect(steps.get(":g")).toBe(6);
    // The seventh shares the first one's ladder step and not its hue: the hue goes round eight.
    const first = terminalChildStyle(120, steps.get(":a"))!;
    const seventh = terminalChildStyle(120, steps.get(":g"))!;
    expect(seventh["--terminal-session-step" as keyof typeof seventh]).toBe("0");
    expect(seventh["--terminal-session-hue" as keyof typeof seventh])
      .not.toBe(first["--terminal-session-hue" as keyof typeof first]);
  });

  it("hands CSS the parent hue and the child's own step, both or neither", () => {
    expect(terminalChildStyle(120, 2)).toEqual({
      "--terminal-hue": "120.00",
      "--terminal-session-step": "2",
      // The Bot palette's walk: nearest 120 is 98, and two steps on from it is 191.
      "--terminal-session-hue": "191.00",
    });
    expect(terminalChildStyle(undefined, 2)).toBeUndefined();
    expect(terminalChildStyle(120, undefined)).toBeUndefined();
  });
});
