import { describe, expect, test } from "vitest";
import type { DirectoryEntry } from "@agentdesk/agent-feed-wire";
import { runtimeOf, runtimesOf } from "@/features/messages/hubRuntime";

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
