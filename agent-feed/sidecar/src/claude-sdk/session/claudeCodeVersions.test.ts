import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeCodeNeeded,
  claudeDiffersFromInstalled,
  sdkClaudeCodeVersion,
} from "@/claude-sdk/session/claudeCodeVersions";

describe("a session's Claude Code against the installed one", () => {
  test("differs only when both are known and are not the same", () => {
    expect(claudeDiffersFromInstalled("2.1.302", "2.1.303")).toBe(true);
    expect(claudeDiffersFromInstalled("2.1.303", "2.1.302")).toBe(true);
    expect(claudeDiffersFromInstalled("2.1.303", "2.1.303")).toBe(false);
    expect(claudeDiffersFromInstalled(null, "2.1.303")).toBe(false);
    expect(claudeDiffersFromInstalled("2.1.303", null)).toBe(false);
  });
});

describe("a session's Claude Code against the one the Agent SDK was built for", () => {
  test("names the SDK's version when the session's is older, comparing each part as a number", () => {
    expect(claudeCodeNeeded("2.1.99", "2.1.302")).toBe("2.1.302");
    expect(claudeCodeNeeded("1.9.999", "2.1.302")).toBe("2.1.302");
    expect(claudeCodeNeeded("2.1.302", "2.1.302")).toBeNull();
    expect(claudeCodeNeeded("2.1.303", "2.1.302")).toBeNull();
    expect(claudeCodeNeeded("2.2.0", "2.1.302")).toBeNull();
  });

  test("says nothing when either version is unknown or not plainly numeric", () => {
    expect(claudeCodeNeeded(null, "2.1.302")).toBeNull();
    expect(claudeCodeNeeded("2.1.0", null)).toBeNull();
    expect(claudeCodeNeeded("2.1.0-beta", "2.1.302")).toBeNull();
  });

  test("reads the SDK's version from the installed library's own manifest", () => {
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
      claudeCodeVersion: string;
    };
    expect(sdkClaudeCodeVersion()).toBe(manifest.claudeCodeVersion);
    expect(sdkClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
