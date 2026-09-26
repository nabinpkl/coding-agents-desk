import { describe, expect, test } from "vitest";
import type { DirectoryEntry } from "@agentdesk/agent-feed-wire";
import { recipientGroups, runtimeOf, runtimesOf } from "@/features/messages/hubRuntime";

function entry(over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    address: "bot:fixer",
    name: "Site fixer",
    machine: "mac",
    reachability: "reachable",
    lastSeenAt: null,
    related: [],
    cwd: "/work/site",
    ...over,
  };
}

describe("runtimeOf", () => {
  test("reads a session's runtime from its address prefix", () => {
    expect(runtimeOf("claude:44444444-4444-4444-4444-444444444444")).toBe("claude");
    expect(runtimeOf("opencode:ses_1")).toBe("opencode");
  });

  test("a Bot and the owner name no runtime", () => {
    expect(runtimeOf("bot:fixer")).toBeNull();
    expect(runtimeOf("human")).toBeNull();
  });
});

describe("runtimesOf", () => {
  test("a session is its own runtime", () => {
    expect(runtimesOf(entry({ address: "opencode:ses_1" }))).toEqual(["opencode"]);
  });

  test("a Bot is whatever its member sessions are, not whatever its name suggests", () => {
    expect(runtimesOf(entry({ related: ["opencode:ses_1"] }))).toEqual(["opencode"]);
    expect(runtimesOf(entry({ related: ["claude:a", "claude:b"] }))).toEqual(["claude"]);
  });

  test("a Bot holding both runtimes is both, because the answer is genuinely both", () => {
    expect(runtimesOf(entry({ related: ["opencode:ses_1", "claude:a"] }))).toEqual(["claude", "opencode"]);
  });

  test("a Bot with no known members claims no runtime rather than guessing", () => {
    expect(runtimesOf(entry())).toEqual([]);
  });
});

describe("recipientGroups", () => {
  const human = entry({ address: "human", name: "owner" });
  const fixer = entry({ address: "bot:fixer", name: "Site fixer", related: ["opencode:a", "opencode:b"] });
  const watcher = entry({ address: "bot:watcher", name: "Watcher", machine: "oracle", related: ["claude:c"] });
  const a = entry({ address: "opencode:a", name: "Fix header", related: ["bot:fixer"] });
  const b = entry({ address: "opencode:b", name: "Fix footer", related: ["bot:fixer"] });
  const c = entry({ address: "claude:c", name: "Watch", machine: "oracle", related: ["bot:watcher"] });
  const loose = entry({ address: "opencode:z", name: "Loose" });

  test("a Bot is a heading and its sessions are the choices, because a Bot cannot be messaged", () => {
    const groups = recipientGroups([human, fixer, a, b]);
    expect(groups.map((group) => group.label)).toEqual(["Site fixer"]);
    expect(groups[0]!.entries.map((entry) => entry.name)).toEqual(["Fix header", "Fix footer"]);
  });

  test("sessions belonging to no Bot come last, so the whole reachable list stays one list", () => {
    const groups = recipientGroups([human, fixer, watcher, a, b, c, loose]);
    expect(groups.map((group) => group.label)).toEqual(["Site fixer", "Watcher", null]);
    expect(groups[2]!.entries.map((entry) => entry.name)).toEqual(["Loose"]);
  });

  test("a session claimed by two Bots is listed once, under the first", () => {
    const shared = entry({ address: "opencode:a", name: "Shared", related: ["bot:fixer"] });
    const groups = recipientGroups([human, fixer, entry({ address: "bot:two", name: "Two", related: ["opencode:a"] }), shared]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.name))).toEqual(["Shared"]);
  });

  test("a Bot with no member sessions the hub knows gets no empty heading", () => {
    const groups = recipientGroups([human, entry({ address: "bot:empty", name: "Empty", related: [] }), loose]);
    expect(groups.map((group) => group.label)).toEqual([null]);
  });

  test("a member address the hub has no row for is skipped rather than offered as a blank", () => {
    const groups = recipientGroups([human, entry({ address: "bot:fixer", name: "Site fixer", related: ["opencode:gone"] }), loose]);
    expect(groups.map((group) => group.label)).toEqual([null]);
    expect(groups[0]!.entries.map((entry) => entry.address)).toEqual(["opencode:z"]);
  });
});
