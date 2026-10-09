import { expect, test } from "bun:test";
import { claudeLaunchPermissionArgs, claudePermissionArgs } from "@/config/configClaudeLaunch";

test("bypass is offered in the Shift+Tab cycle without being the mode a session starts in", () => {
  expect(claudePermissionArgs("auto", true))
    .toEqual(["--permission-mode", "auto", "--allow-dangerously-skip-permissions"]);
});

test("turning bypass off leaves only the starting mode", () => {
  expect(claudePermissionArgs("manual", false)).toEqual(["--permission-mode", "manual"]);
});

test("with nothing set, sessions start in auto with bypass offered", () => {
  if (process.env.AGENT_FEED_CLAUDE_PERMISSION_MODE || process.env.AGENT_FEED_CLAUDE_ALLOW_BYPASS) return;
  expect(claudeLaunchPermissionArgs)
    .toEqual(["--permission-mode", "auto", "--allow-dangerously-skip-permissions"]);
});
