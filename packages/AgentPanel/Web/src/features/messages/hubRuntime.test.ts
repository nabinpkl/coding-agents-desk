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
  const a = entry({ address: "opencode:a", name: "Fix header", cwd: "/Users/n/desk", related: ["bot:fixer"] });
  const b = entry({ address: "opencode:b", name: "Fix footer", cwd: "/Users/n/desk", related: ["bot:fixer"] });
  const looseMac = entry({ address: "opencode:z", name: "Loose", cwd: "/Users/n/notes" });
  const looseOracle = entry({ address: "claude:c", name: "Oracle one", machine: "oracle", cwd: "/home/ubuntu/rags" });

  test("a Bot is a heading and its sessions are the choices, because a Bot cannot be messaged", () => {
    const groups = recipientGroups([human, fixer, a, b]);
    expect(groups.map((group) => group.label)).toEqual(["Site fixer"]);
    expect(groups[0]!.entries.map((entry) => entry.name)).toEqual(["Fix header", "Fix footer"]);
  });

  test("a loose session is grouped by the machine and directory it runs in", () => {
    const groups = recipientGroups([human, fixer, a, b, looseMac, looseOracle]);
    expect(groups.map((group) => group.label)).toEqual([
      "Site fixer",
      "mac · notes",
      "oracle · rags",
    ]);
  });

  test("two directories with the same last segment on one machine are told apart by one more segment", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "One", cwd: "/Users/n/a/tmp" }),
      entry({ address: "opencode:two", name: "Two", cwd: "/Users/n/b/tmp" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["mac · a/tmp", "mac · b/tmp"]);
  });

  test("a home directory is named as one, because its last segment names the reader", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "Annotator probe", cwd: "/Users/dev" }),
      entry({ address: "opencode:two", name: "Probe", machine: "oracle", cwd: "/home/ubuntu" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["mac · home", "oracle · home"]);
  });

  test("a two-segment path that is not a home is named by its own segment", () => {
    // `/work/other` is two segments long and is nobody's home directory, which is why the check
    // is on the second segment being `Users` or `home` rather than on the length.
    const groups = recipientGroups([human, entry({ address: "opencode:one", name: "One", cwd: "/work/other" })]);
    expect(groups.map((group) => group.label)).toEqual(["mac · other"]);
  });

  test("the same directory name on two machines is not a collision", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "One", cwd: "/Users/n/agent-desk" }),
      entry({ address: "opencode:two", name: "Two", machine: "oracle", cwd: "/home/ubuntu/agent-desk" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["mac · agent-desk", "oracle · agent-desk"]);
  });

  test("two sessions with the same name in one group get the id tail, and unique ones do not", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:aaaaaa111", name: "Same", cwd: "/Users/n/desk" }),
      entry({ address: "opencode:bbbbbb222", name: "Same", cwd: "/Users/n/desk" }),
      entry({ address: "opencode:cccccc333", name: "Unique", cwd: "/Users/n/desk" }),
    ]);
    const names = groups[0]!.entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("Same · aaa111");
    expect(names).toContain("Same · bbb222");
    expect(names).toContain("Unique");
  });

  test("sessions belonging to no Bot stay in the list, one click away", () => {
    const groups = recipientGroups([human, looseMac]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.address))).toContain("opencode:z");
  });

  test("a session claimed by two Bots is listed once, under the first", () => {
    const shared = entry({ address: "opencode:a", name: "Shared", cwd: "/w", related: ["bot:fixer"] });
    const groups = recipientGroups([human, fixer, entry({ address: "bot:two", name: "Two", related: ["opencode:a"] }), shared]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.name))).toEqual(["Shared"]);
  });

  test("a Bot with no member sessions the hub knows gets no empty heading", () => {
    const groups = recipientGroups([human, entry({ address: "bot:empty", name: "Empty", related: [] }), looseMac]);
    expect(groups.map((group) => group.label)).toEqual(["mac · notes"]);
  });

  test("a member address the hub has no row for is skipped rather than offered as a blank", () => {
    const groups = recipientGroups([human, entry({ address: "bot:fixer", name: "Site fixer", related: ["opencode:gone"] }), looseMac]);
    expect(groups.map((group) => group.label)).toEqual(["mac · notes"]);
  });
});
