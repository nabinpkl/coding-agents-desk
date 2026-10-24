// Which Claude Code an SDK session runs, held against the one installed now and the one the Agent
// SDK library was built for.
//
// The runner hands the SDK `~/.local/bin/claude` (`claudeBinary`), never the binary the library
// bundles, so the CLI a session runs is whatever that path named when its runner started. The
// native installer moves the path to each new version as it lands, and a runner keeps the CLI it
// started with for as long as it runs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether a session's CLI is not the one a launch now would run, which relaunches its runner once
 * the session is idle. Unknown on either side is no difference: a CLI that has not said its version
 * yet, or an install whose path does not name one (Homebrew, a wrapper script).
 *
 * The CLI says its version on `system/init`, which it sends only once a turn starts. So a runner
 * that has run no turn since it started is not caught here; its next turn names the version, and the
 * relaunch follows when that turn ends.
 */
export function claudeDiffersFromInstalled(running: string | null, installed: string | null): boolean {
  return running !== null && installed !== null && running !== installed;
}

let sdkVersion: { value: string | null } | null = null;

/**
 * The CLI version the Agent SDK library was built for: its `package.json`'s `claudeCodeVersion`,
 * which the library publishes beside its own version. Read once, since the library only changes
 * with an install, which restarts this process.
 */
export function sdkClaudeCodeVersion(): string | null {
  if (sdkVersion) return sdkVersion.value;
  const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
    claudeCodeVersion?: unknown;
  };
  sdkVersion = { value: typeof manifest.claudeCodeVersion === "string" ? manifest.claudeCodeVersion : null };
  return sdkVersion.value;
}

/**
 * The version the Agent SDK was built for, when the session's CLI is older than it; null when it is
 * not, or when either version is unknown. An older CLI may not understand what the library sends.
 */
export function claudeCodeNeeded(
  running: string | null,
  expected: string | null = sdkClaudeCodeVersion(),
): string | null {
  return running !== null && expected !== null && olderVersion(running, expected) ? expected : null;
}

/** Whether dotted version `a` is older than `b`, part by part; anything not plainly numeric is not. */
function olderVersion(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  if ([...left, ...right].some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}
