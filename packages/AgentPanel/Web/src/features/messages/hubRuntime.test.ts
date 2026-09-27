import { describe, expect, test } from "vitest";
import type { DirectoryEntry } from "@agentdesk/agent-feed-wire";
import { BOTS_SECTION, recipientGroups, runtimeOf, runtimesOf, SESSIONS_SECTION } from "@/features/messages/hubRuntime";

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
    expect(groups.map((group) => group.label)).toEqual(["All bots · Site fixer", "All sessions · mac · desk"]);
    expect(groups[0]!.entries.map((entry) => entry.name)).toEqual(["Fix header", "Fix footer"]);
  });

  test("the two sections are two views of the same sessions, so the overlap is the point", () => {
    // The Bot section answers "what does this Bot have running" and the session section answers
    // "what can I reach". Neither is wrong alone, so a session attached to a Bot is in both.
    const groups = recipientGroups([human, fixer, a, b, looseMac, looseOracle]);
    const addresses = groups.map((group) => group.entries.map((entry) => entry.address));
    expect(addresses[0]).toEqual(["opencode:a", "opencode:b"]);
    expect(addresses[1]).toEqual(["opencode:a", "opencode:b"]);
    expect(addresses[2]).toEqual(["opencode:z"]);
    expect(addresses[3]).toEqual(["claude:c"]);
  });

  test("every group heading names its top-level section, so the two are readable while scrolling", () => {
    const groups = recipientGroups([human, fixer, a, looseMac]);
    const sections = new Set(groups.map((group) => group.label.split(" · ")[0]));
    expect(sections).toEqual(new Set([BOTS_SECTION, SESSIONS_SECTION]));
  });

  test("a loose session is grouped by the machine and directory it runs in", () => {
    const groups = recipientGroups([human, fixer, a, b, looseMac, looseOracle]);
    expect(groups.map((group) => group.label)).toEqual([
      "All bots · Site fixer",
      "All sessions · mac · desk",
      "All sessions · mac · notes",
      "All sessions · oracle · rags",
    ]);
  });

  test("two directories with the same last segment on one machine are told apart by one more segment", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "One", cwd: "/Users/n/a/tmp" }),
      entry({ address: "opencode:two", name: "Two", cwd: "/Users/n/b/tmp" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · a/tmp", "All sessions · mac · b/tmp"]);
  });

  test("a directory holding several sessions is one directory, not several that collide", () => {
    // The collision check is over distinct paths rather than distinct basenames. Counting three
    // sessions in one directory as three directories ending in the same name grew every busy
    // directory's heading by a segment, which is what made `mac · projects/agent-desk` appear
    // where `mac · agent-desk` was the honest label.
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "One", cwd: "/Users/n/desk" }),
      entry({ address: "opencode:two", name: "Two", cwd: "/Users/n/desk" }),
      entry({ address: "opencode:three", name: "Three", cwd: "/Users/n/desk" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · desk"]);
  });

  test("a home directory is named as one, because its last segment names the reader", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "Annotator probe", cwd: "/Users/dev" }),
      entry({ address: "opencode:two", name: "Probe", machine: "oracle", cwd: "/home/ubuntu" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · home", "All sessions · oracle · home"]);
  });

  test("a two-segment path that is not a home is named by its own segment", () => {
    // `/work/other` is two segments long and is nobody's home directory, which is why the check
    // is on the second segment being `Users` or `home` rather than on the length.
    const groups = recipientGroups([human, entry({ address: "opencode:one", name: "One", cwd: "/work/other" })]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · other"]);
  });

  test("the same directory name on two machines is not a collision", () => {
    const groups = recipientGroups([
      human,
      entry({ address: "opencode:one", name: "One", cwd: "/Users/n/agent-desk" }),
      entry({ address: "opencode:two", name: "Two", machine: "oracle", cwd: "/home/ubuntu/agent-desk" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "All sessions · mac · agent-desk",
      "All sessions · oracle · agent-desk",
    ]);
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

  test("a Bot with no member sessions the hub knows gets no empty heading", () => {
    const groups = recipientGroups([human, entry({ address: "bot:empty", name: "Empty", related: [] }), looseMac]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · notes"]);
  });

  test("a member address the hub has no row for is skipped rather than offered as a blank", () => {
    const groups = recipientGroups([human, entry({ address: "bot:fixer", name: "Site fixer", related: ["opencode:gone"] }), looseMac]);
    expect(groups.map((group) => group.label)).toEqual(["All sessions · mac · notes"]);
  });
});
