// The permission mode a Claude session this sidecar starts, forks or resumes opens in.
//
// Passed on the command line rather than left to the reader's own `permissions.defaultMode`,
// because a peer's settings are not this Mac's, and a session that opens in a different mode
// depending on which machine started it is the surprise this exists to remove.
//
// Bypass is ALLOWED, not chosen: `--allow-dangerously-skip-permissions` puts "bypass permissions"
// into the Shift+Tab cycle without starting there. Measured 2026-10-09 on CLI 2.1.295: without
// the flag the cycle is manual, accept edits and plan, and bypass never appears; with it, bypass
// sits between plan and manual. Auto is a property of the model as well as the flag -- Haiku
// reports "auto mode unavailable for this model" and opens in manual.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import { booleanEnvironment } from "@/config/configEnvironment";

function permissionModeEnvironment(name: string, fallback: ClaudePermissionMode): ClaudePermissionMode {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  return raw as ClaudePermissionMode;
}

/** The flags, from the two settings. Separate from the environment so a test can name them. */
export function claudePermissionArgs(mode: ClaudePermissionMode, allowBypass: boolean): string[] {
  const args = ["--permission-mode", mode];
  if (allowBypass) args.push("--allow-dangerously-skip-permissions");
  return args;
}

export const claudeLaunchPermissionArgs = claudePermissionArgs(
  permissionModeEnvironment("AGENT_FEED_CLAUDE_PERMISSION_MODE", "auto"),
  booleanEnvironment("AGENT_FEED_CLAUDE_ALLOW_BYPASS", true),
);

/**
 * The mods every session this sidecar launches loads, in this order: the prompt guard, then the
 * hub mod that delivers agent-hub messages as prompts (`mods/README.md`).
 *
 * Loaded with `--plugin-dir` from the sidecar's own tree rather than installed, because a
 * `--plugin-dir` mod reloads live when its files change and an installed one waits for the next
 * session start. A running session predates a change to this list, so the stale-session check
 * reads it beside the permission flags and lists every session launched without it for the
 * Profile menu's restart.
 */
export const LAUNCH_MODS = ["prompt-guard", "agentdesk-hub"] as const;

/**
 * The `--plugin-dir` flags for the mods under `modsRoot`. None when the mods are switched off, or
 * not on disk: the bundled sidecar carries no source tree, and a flag naming a directory that is
 * not there would only put an error in every session it launches.
 */
export function claudeModArgs(modsRoot: string, enabled: boolean): string[] {
  if (!enabled) return [];
  return LAUNCH_MODS.flatMap((name) => {
    const dir = join(modsRoot, name);
    return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? ["--plugin-dir", dir] : [];
  });
}

/** `agent-feed/sidecar/mods`, beside this file's `src/`. */
const MODS_ROOT = fileURLToPath(new URL("../../mods/", import.meta.url));

export const claudeLaunchModArgs = claudeModArgs(MODS_ROOT, booleanEnvironment("AGENT_FEED_CLAUDE_MODS", true));

/** Everything a launched Claude session's command line carries from this sidecar. */
export const claudeLaunchArgs: readonly string[] = [...claudeLaunchPermissionArgs, ...claudeLaunchModArgs];
