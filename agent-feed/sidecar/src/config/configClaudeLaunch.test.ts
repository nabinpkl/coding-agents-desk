import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_MODS,
  claudeLaunchAllowedTools,
  claudeLaunchArgs,
  claudeLaunchModArgs,
  claudeLaunchPermissionArgs,
  claudeModArgs,
  claudePermissionArgs,
} from "@/config/configClaudeLaunch";

test("bypass is offered in the Shift+Tab cycle without being the mode a session starts in", () => {
  expect(claudePermissionArgs("auto", true)).toEqual([
    "--permission-mode",
    "auto",
    "--allow-dangerously-skip-permissions",
  ]);
});

test("turning bypass off leaves only the starting mode", () => {
  expect(claudePermissionArgs("manual", false)).toEqual(["--permission-mode", "manual"]);
});

test("with nothing set, sessions start in auto with bypass offered", () => {
  if (process.env.AGENT_FEED_CLAUDE_PERMISSION_MODE || process.env.AGENT_FEED_CLAUDE_ALLOW_BYPASS) return;
  expect(claudeLaunchPermissionArgs).toEqual(["--permission-mode", "auto", "--allow-dangerously-skip-permissions"]);
});

test("each mod on disk becomes one --plugin-dir, in the guard-first order, and none when off", () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-launch-mods-"));
  try {
    for (const name of LAUNCH_MODS) {
      mkdirSync(join(root, name, ".claude-plugin"), { recursive: true });
      writeFileSync(join(root, name, ".claude-plugin", "plugin.json"), "{}");
    }
    expect(claudeModArgs(root, true)).toEqual([
      "--plugin-dir",
      join(root, "prompt-guard"),
      "--plugin-dir",
      join(root, "agentdesk-hub"),
      "--plugin-dir",
      join(root, "ask-owner"),
    ]);
    expect(claudeModArgs(root, false)).toEqual([]);
    // A tree without the mods, as the bundled sidecar is, launches without the flags.
    expect(claudeModArgs(join(root, "nowhere"), true)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run from this source tree, launches load the mods beside the permission flags, and pre-approve ask_owner", () => {
  if (process.env.AGENT_FEED_CLAUDE_MODS) return;
  expect(
    claudeLaunchModArgs.filter((arg) => arg !== "--plugin-dir").map((dir) => dir.split("/").slice(-3).join("/")),
  ).toEqual(["sidecar/mods/prompt-guard", "sidecar/mods/agentdesk-hub", "sidecar/mods/ask-owner"]);
  // Only the mod's own tool, by the name Claude Code gives a mod's tool (measured 2026-10-22).
  expect(claudeLaunchAllowedTools).toEqual(["mcp__plugin_ask-owner_ask__ask_owner"]);
  expect(claudeLaunchArgs).toEqual([
    ...claudeLaunchPermissionArgs,
    ...claudeLaunchModArgs,
    "--allowedTools",
    "mcp__plugin_ask-owner_ask__ask_owner",
  ]);
});
