// Where a binary this machine may not have actually is.
//
// Both answers are absolute paths or null, never a bare name: the host strips the PATH that
// would find a Homebrew install from its children, so a name resolved at spawn time finds
// nothing. Null is a real answer, reported by the callers rather than guessed around.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const userHomeDirectory = homedir();

/**
 * Absolute path to the `yabai` binary, or null when this machine has none.
 *
 * Searched rather than assumed, and absolute rather than resolved from PATH,
 * because the host deliberately strips the PATH that would find a Homebrew
 * install from its children (the same reason `bun` is passed in by absolute
 * path). Null is a real answer: the park routes answer 503 with a reason
 * instead of failing at spawn time.
 */
/**
 * Same shape as `yabaiBinary`, and for the same reason: the sidecar's child environment is
 * stripped of the PATH that would find a Homebrew install, so an absolute path is the only kind
 * that works. Null means "not installed", which callers report rather than guess around.
 */
export function tmuxBinary(): string | null {
  const override = process.env.AGENT_FEED_TMUX_PATH?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    join(userHomeDirectory, ".local", "bin", "tmux"),
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function yabaiBinary(): string | null {
  const override = process.env.AGENT_FEED_YABAI_PATH?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    join(userHomeDirectory, ".local", "bin", "yabai"),
    "/opt/homebrew/bin/yabai",
    "/usr/local/bin/yabai",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
