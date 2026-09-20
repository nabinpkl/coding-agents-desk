import { describe, expect, it } from "vitest";
import {
  groupTerminalsByDirectory,
  mintTerminalSessionName,
  parseTerminalChildKey,
  suggestTerminalSessionName,
  terminalChildKey,
  terminalSessionNameError,
} from "@/features/terminal/canvas/terminalGroups";

function session(name: string, path: string) {
  return { name, windows: 1, attachedClients: 0, path };
}

describe("groupTerminalsByDirectory", () => {
  it("stands one parent per directory with its sessions name-sorted inside", () => {
    const { parents, residue } = groupTerminalsByDirectory([{
      machineLabel: "mac",
      sessions: [session("zebra", "/proj"), session("apple", "/proj"), session("solo", "/other")],
      workspaceRoots: [],
      botDirs: [],
    }]);
    expect(residue).toEqual([]);
    expect(parents.map((parent) => parent.path)).toEqual(["/other", "/proj"]);
    expect(parents[1]!.children.map((child) => child.name)).toEqual(["apple", "zebra"]);
    expect(parents[1]!.key).toBe(":/proj");
  });

  it("keeps an empty registered directory standing as the place a shell gets started", () => {
    const { parents } = groupTerminalsByDirectory([{
      machineLabel: "mac",
      sessions: [],
      workspaceRoots: ["/registered"],
      botDirs: ["/bot-dir", "/registered/"],
    }]);
    expect(parents.map((parent) => parent.path)).toEqual(["/bot-dir", "/registered"]);
    expect(parents[0]!.children).toEqual([]);
  });

  it("never merges one path across two machines", () => {
    const { parents } = groupTerminalsByDirectory([
      { machineId: undefined, machineLabel: "mac", sessions: [session("a", "/proj")], workspaceRoots: [], botDirs: [] },
      { machineId: "peer", machineLabel: "peer", sessions: [session("a", "/proj")], workspaceRoots: [], botDirs: [] },
    ]);
    expect(parents.map((parent) => parent.key)).toEqual([":/proj", "peer:/proj"]);
  });

  it("parks pathless sessions in their own machine's residue group, after the parents", () => {
    const { parents, residue } = groupTerminalsByDirectory([{
      machineLabel: "mac",
      sessions: [session("lost", ""), session("kept", "/proj")],
      workspaceRoots: [],
      botDirs: [],
    }]);
    expect(parents.map((parent) => parent.path)).toEqual(["/proj"]);
    expect(residue).toHaveLength(1);
    expect(residue[0]!.path).toBe("");
    expect(residue[0]!.key).toBe(":");
    expect(residue[0]!.children.map((child) => child.name)).toEqual(["lost"]);
  });

  it("strips a trailing slash, so one directory is not two parents", () => {
    const { parents } = groupTerminalsByDirectory([{
      machineLabel: "mac",
      sessions: [session("a", "/proj/")],
      workspaceRoots: ["/proj"],
      botDirs: [],
    }]);
    expect(parents).toHaveLength(1);
    expect(parents[0]!.path).toBe("/proj");
  });
});

describe("terminalChildKey", () => {
  it("scopes the name to its machine, because names are per-server", () => {
    expect(terminalChildKey(undefined, "a")).toBe(":a");
    expect(terminalChildKey("peer", "a")).toBe("peer:a");
  });

  it("mints names no person would type and no two starters share", () => {
    const first = mintTerminalSessionName();
    const second = mintTerminalSessionName();
    expect(first).toMatch(/^agentterm-[0-9a-f]{8}$/);
    expect(second).toMatch(/^agentterm-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it("parses back what it built, and refuses what it could not have built", () => {
    expect(parseTerminalChildKey(":a")).toEqual({ machineId: undefined, session: "a" });
    expect(parseTerminalChildKey("peer:a")).toEqual({ machineId: "peer", session: "a" });
    expect(parseTerminalChildKey("no-colon")).toBeNull();
    expect(parseTerminalChildKey(":")).toBeNull();
    expect(parseTerminalChildKey("a:")).toBeNull();
    expect(parseTerminalChildKey("a:b:c")).toBeNull();
  });
});

describe("suggestTerminalSessionName", () => {
  it("offers the directory leaf plus one past the standing count", () => {
    expect(suggestTerminalSessionName("/proj", [])).toBe("proj-1");
    expect(suggestTerminalSessionName("/proj", ["a", "b"])).toBe("proj-3");
  });

  it("steps over a collision standing anywhere on the machine, not just this directory", () => {
    expect(suggestTerminalSessionName("/proj", ["a", "proj-2", "proj-3"])).toBe("proj-4");
  });

  it("folds the leaf to tmux identifier characters, with a fallback for none", () => {
    expect(suggestTerminalSessionName("/my project!", [])).toBe("my-project-1");
    expect(suggestTerminalSessionName("/", [])).toBe("term-1");
  });

  it("stays a plain identifier inside the length limit", () => {
    const name = suggestTerminalSessionName(`/${"a".repeat(100)}`, []);
    expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);
    expect(name).toContain("-1");
  });
});

describe("terminalSessionNameError", () => {
  it("accepts a free plain identifier", () => {
    expect(terminalSessionNameError("proj-4", ["a", "b"])).toBeNull();
  });

  it("refuses an empty name, a non-identifier, and a standing name", () => {
    expect(terminalSessionNameError("   ", [])).toContain("default");
    expect(terminalSessionNameError("has space", [])).toContain("Letters");
    expect(terminalSessionNameError("a:b", [])).toContain("Letters");
    expect(terminalSessionNameError("a", ["a", "b"])).toContain("already standing");
  });
});
