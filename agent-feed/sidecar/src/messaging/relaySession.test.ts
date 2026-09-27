import { describe, expect, test } from "bun:test";
import { argvLoadsChannel } from "@/messaging/relaySession";

describe("argvLoadsChannel", () => {
  test("finds the server among the flag's entries", () => {
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels", "server:agentdesk-relay"])).toBe(true);
    expect(argvLoadsChannel(["claude", "--resume", "abc", "--dangerously-load-development-channels", "server:probe", "server:agentdesk-relay", "--model", "haiku"])).toBe(true);
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels=server:agentdesk-relay"])).toBe(true);
  });

  test("a session without the flag, or loading another server, is not a channel for this one", () => {
    expect(argvLoadsChannel(["claude", "--resume", "abc"])).toBe(false);
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels", "server:probe", "--model", "server:agentdesk-relay"])).toBe(false);
    expect(argvLoadsChannel(["claude", "--channels", "server:agentdesk-relay"])).toBe(false);
  });
});
