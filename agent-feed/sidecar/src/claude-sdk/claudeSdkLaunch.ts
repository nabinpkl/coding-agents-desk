// Starting a Claude session in SDK mode: the runner, in the session's own tmux pane (ADR-0143).
//
// The same pane a terminal session gets -- the name `claudeSessionPaneName` derives, the identity
// stamp, the rename to the title -- so everything that finds a session's pane finds this one, and
// a card's terminal joins it rather than opening a second process beside it. What runs in it is the
// runner instead of the TUI, and its screen is the runner's log.
//
// The runner is started by tmux and not by this process, because this process restarts on every
// save and the session must not.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "@/config/config";
import { claudeBinary } from "@/config/configBinaries";
import { claudeLaunchModDirectories, claudeLaunchPermission } from "@/config/configClaudeLaunch";
import {
  claudeSessionPaneName,
  UNATTENDED_COLUMNS,
  UNATTENDED_ROWS,
  type StartedClaudeSession,
} from "@/terminal/session-panes/claudeSessionLaunch";
import { RUNNER_ENTRY_FILE } from "@/claude-sdk/claudeSdkProtocol";
import { createTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { adoptTitleName } from "@/terminal/tmux/tmuxRelabel";

/** The runner's entry, by path, because tmux runs it as a file rather than as a module of ours. */
export const RUNNER_MAIN = fileURLToPath(new URL(`./${RUNNER_ENTRY_FILE}`, import.meta.url));

/** SDK mode cannot start here: no source tree to run the runner from, no bun, or no `claude`. */
export class ClaudeSdkUnavailableError extends Error {}

/**
 * The bun that runs the runner: this process's own, which is bun whenever the sidecar is running
 * from source. The bundled sidecar is one compiled binary with no `.ts` beside it, so SDK mode is
 * refused there with a reason rather than started into a pane that dies at once.
 */
function runnerBun(): string {
  if (!existsSync(RUNNER_MAIN)) throw new ClaudeSdkUnavailableError("SDK mode needs the sidecar running from source");
  if (!basename(process.execPath).startsWith("bun")) {
    throw new ClaudeSdkUnavailableError(`SDK mode needs bun, and this sidecar runs on ${process.execPath}`);
  }
  return process.execPath;
}

/**
 * The runner's whole command line: everything it needs, decided here, so it reads no config.
 *
 * Opens in the mode a terminal session opens in and loads the same mods (`configClaudeLaunch.ts`).
 * The session id is on it, which is what tells a later reader of the pane whose session it holds.
 */
export function claudeSdkRunnerCommand(options: {
  sessionId: string;
  cwd: string;
  title: string;
  start: "new" | "resume";
  firstTurnFile?: string;
}): string[] {
  const claude = claudeBinary();
  if (!claude) throw new ClaudeSdkUnavailableError("claude is not installed on this machine");
  return [
    runnerBun(),
    RUNNER_MAIN,
    "--session", options.sessionId,
    "--cwd", options.cwd,
    "--name", options.title,
    "--start", options.start,
    "--permission-mode", claudeLaunchPermission.mode,
    ...(claudeLaunchPermission.allowBypass ? ["--allow-bypass"] : []),
    ...claudeLaunchModDirectories.flatMap((directory) => ["--plugin-dir", directory]),
    "--claude", claude,
    "--socket-dir", config.claudeSdkSocketDirectory,
    ...(options.firstTurnFile ? ["--first-turn-file", options.firstTurnFile] : []),
  ];
}

/**
 * Starts a fresh session in SDK mode, in its own detached pane.
 *
 * The first turn goes through a private file the runner reads and deletes, for the reason the
 * terminal's does (`claudeSessionLaunch.ts`): tmux refuses a command line much past 16KB.
 */
export async function startClaudeSdkSession(options: {
  cwd: string;
  sessionId: string;
  title: string;
  prompt?: string;
}): Promise<StartedClaudeSession> {
  const pane = claudeSessionPaneName(options.sessionId);
  const directory = options.prompt ? await mkdtemp(join(tmpdir(), "agentdesk-first-turn-")) : null;
  try {
    const firstTurnFile = directory ? join(directory, "turn.txt") : undefined;
    if (firstTurnFile) await writeFile(firstTurnFile, options.prompt!, { mode: 0o600 });
    await createTmuxSession({
      session: pane,
      cwd: options.cwd,
      command: claudeSdkRunnerCommand({ ...options, start: "new", ...(firstTurnFile ? { firstTurnFile } : {}) }),
      columns: UNATTENDED_COLUMNS,
      rows: UNATTENDED_ROWS,
    });
  } catch (error) {
    // The runner deletes the file once it has read it; when no runner started, nothing else will.
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const tmuxSession = await adoptTitleName(pane, options.sessionId, options.title);
  return { sessionId: options.sessionId, title: options.title, tmuxSession };
}
