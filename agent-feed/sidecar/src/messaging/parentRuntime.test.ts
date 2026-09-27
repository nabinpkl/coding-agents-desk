import { describe, expect, test } from "bun:test";
import { parentCommand, parentRuntime } from "@/messaging/parentRuntime";
import { argvLoadsChannel } from "@/messaging/relaySession";

describe("parentRuntime", () => {
  test("a dead pid is claude, which then fails on the registry read rather than pretending", () => {
    expect(parentRuntime(999_999)).toBe("claude");
  });

  test("this test process is a real parent whose command reads as a runtime", () => {
    expect(["claude", "opencode"]).toContain(parentRuntime());
    expect(parentCommand(process.ppid).length).toBeGreaterThan(0);
  });
});

describe("argvLoadsChannel", () => {
  test("the claude channel flag still parses the same way", () => {
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels", "server:agentdesk-relay"])).toBe(true);
  });
});
