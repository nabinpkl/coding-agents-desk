import { describe, expect, it } from "vitest";
import { groupTerminalsByDirectory, parseTerminalChildKey, terminalChildKey } from "@/features/terminal/canvas/terminalGroups";

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

  it("parses back what it built, and refuses what it could not have built", () => {
    expect(parseTerminalChildKey(":a")).toEqual({ machineId: undefined, session: "a" });
    expect(parseTerminalChildKey("peer:a")).toEqual({ machineId: "peer", session: "a" });
    expect(parseTerminalChildKey("no-colon")).toBeNull();
    expect(parseTerminalChildKey(":")).toBeNull();
    expect(parseTerminalChildKey("a:")).toBeNull();
    expect(parseTerminalChildKey("a:b:c")).toBeNull();
  });
});
