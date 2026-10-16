// Where a binary this machine may not have actually is.
//
// Both answers are absolute paths or null, never a bare name: the host strips the PATH that
// would find a Homebrew install from its children, so a name resolved at spawn time finds
// nothing. Null is a real answer, reported by the callers rather than guessed around.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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

/**
 * Absolute path to the `claude` CLI, or null when this machine has none. Same shape as
 * `tmuxBinary`: the arena spawns it directly rather than through a login shell, so a bare
 * name resolves against the stripped PATH and finds nothing. (A tmux pane's `claude` resolves
 * because the pane runs a login shell.)
 */
export function claudeBinary(): string | null {
  const override = process.env.AGENT_FEED_CLAUDE_PATH?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    join(userHomeDirectory, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * The version a `claude` launched now would run, or null when the install does not say.
 *
 * Read from where the binary resolves to, because the native installer keeps every version as
 * `~/.local/share/claude/versions/<version>` and points `~/.local/bin/claude` at the newest one --
 * the same comparison the CLI's own footer makes when it says "Restart to update". An install that
 * resolves to anything not named for a version (Homebrew, a wrapper script) answers null, which
 * callers report as unknown rather than reading every session as current or as stale.
 */
export function installedClaudeVersion(): string | null {
  const binary = claudeBinary();
  if (!binary) return null;
  let target: string;
  try {
    target = realpathSync(binary);
  } catch {
    return null;
  }
  const name = basename(target);
  return /^\d+\.\d+\.\d+$/.test(name) ? name : null;
}

/**
 * Absolute path to the `opencode` CLI, or null when this machine has none.
 *
 * Absolute even for a tmux pane, unlike `claude`: opencode's installer puts it in
 * `~/.opencode/bin` and adds that to PATH in the interactive shell's rc file only, so the login
 * shell a pane runs its command through does not find it. Measured: `zsh:1: command not found:
 * opencode` in an arena pane on a machine where an interactive shell found it.
 */
export function opencodeBinary(): string | null {
  const override = process.env.AGENT_FEED_OPENCODE_PATH?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    join(userHomeDirectory, ".opencode", "bin", "opencode"),
    join(userHomeDirectory, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
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

/**
 * Absolute path to `rg`, or null when this machine has none.
 *
 * Both of the IDE's searches run on it: quick open lists files with `rg --files`, and the Search
 * section searches inside them. Same shape as `tmuxBinary` and for the same reason; `/usr/bin` is
 * where a Debian or Ubuntu package puts it, which is the oracle peer.
 */
export function ripgrepBinary(): string | null {
  const override = process.env.AGENT_FEED_RIPGREP_PATH?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    join(userHomeDirectory, ".local", "bin", "rg"),
    join(userHomeDirectory, ".cargo", "bin", "rg"),
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
