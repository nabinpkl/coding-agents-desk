import { describe, expect, test } from "bun:test";
import { argvLoadsChannel, argvLoadsHubMod } from "@/messaging/relaySession";

describe("argvLoadsChannel", () => {
  test("finds the server among the flag's entries", () => {
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels", "server:agentdesk-relay"])).toBe(
      true,
    );
    expect(
      argvLoadsChannel([
        "claude",
        "--resume",
        "abc",
        "--dangerously-load-development-channels",
        "server:probe",
        "server:agentdesk-relay",
        "--model",
        "haiku",
      ]),
    ).toBe(true);
    expect(argvLoadsChannel(["claude", "--dangerously-load-development-channels=server:agentdesk-relay"])).toBe(true);
  });

  test("a session without the flag, or loading another server, is not a channel for this one", () => {
    expect(argvLoadsChannel(["claude", "--resume", "abc"])).toBe(false);
    expect(
      argvLoadsChannel([
        "claude",
        "--dangerously-load-development-channels",
        "server:probe",
        "--model",
        "server:agentdesk-relay",
      ]),
    ).toBe(false);
    expect(argvLoadsChannel(["claude", "--channels", "server:agentdesk-relay"])).toBe(false);
  });
});

describe("argvLoadsHubMod", () => {
  test("a --plugin-dir naming the agentdesk-hub directory, in either spelling", () => {
    expect(argvLoadsHubMod(["claude", "--plugin-dir", "/repo/agent-feed/sidecar/mods/agentdesk-hub"])).toBe(true);
    expect(argvLoadsHubMod(["claude", "--plugin-dir=/repo/mods/agentdesk-hub/"])).toBe(true);
    expect(
      argvLoadsHubMod([
        "claude",
        "--plugin-dir",
        "/repo/mods/prompt-guard",
        "--plugin-dir",
        "/repo/mods/agentdesk-hub",
      ]),
    ).toBe(true);
  });

  test("another plugin, a look-alike name, or the name anywhere but a --plugin-dir value is not it", () => {
    expect(argvLoadsHubMod(["claude", "--plugin-dir", "/repo/mods/prompt-guard"])).toBe(false);
    expect(argvLoadsHubMod(["claude", "--plugin-dir", "/repo/mods/agentdesk-hub-old"])).toBe(false);
    expect(argvLoadsHubMod(["claude", "-n", "agentdesk-hub"])).toBe(false);
    expect(argvLoadsHubMod(["claude", "--plugin-dir"])).toBe(false);
  });
});
