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
import type { ClaudePermissionMode, ClaudeRunMode } from "@agentdesk/agent-feed-wire";
import {
  claudeForkPaneName,
  claudeSessionPaneName,
  forkFirstTurn,
  resumeClaudeSessionCommand,
  UNATTENDED_COLUMNS,
  UNATTENDED_ROWS,
  lastResumeSelection,
  type ResumeSelection,
  type StartedClaudeSession,
} from "@/terminal/session-panes/claudeSessionLaunch";
import { isEffortLevel, RUNNER_ENTRY_FILE, type RunnerChoices } from "@/claude-sdk/claudeSdkProtocol";
import { sdkPermissionMode } from "@/claude-sdk/session/claudeSdkSession";
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
  start: "new" | "resume" | "fork";
  /** For a fork: the session it branches from, and the record to cut that history at. */
  forkFrom?: string;
  resumeAt?: string;
  firstTurnFile?: string;
  /** The model and effort the session had chosen, which a relaunch keeps. */
  choices?: RunnerChoices;
  /** The mode to open in, in the CLI's names; the launch default when absent. */
  permissionMode?: ClaudePermissionMode;
}): string[] {
  const claude = claudeBinary();
  if (!claude) throw new ClaudeSdkUnavailableError("claude is not installed on this machine");
  return [
    runnerBun(),
    RUNNER_MAIN,
    "--session",
    options.sessionId,
    "--cwd",
    options.cwd,
    "--name",
    options.title,
    "--start",
    options.start,
    "--permission-mode",
    sdkPermissionMode(options.permissionMode ?? claudeLaunchPermission.mode),
    ...(claudeLaunchPermission.allowBypass ? ["--allow-bypass"] : []),
    ...claudeLaunchModDirectories.flatMap((directory) => ["--plugin-dir", directory]),
    "--claude",
    claude,
    "--socket-dir",
    config.claudeSdkSocketDirectory,
    ...(options.forkFrom ? ["--fork-from", options.forkFrom] : []),
    ...(options.resumeAt ? ["--resume-at", options.resumeAt] : []),
    ...(options.firstTurnFile ? ["--first-turn-file", options.firstTurnFile] : []),
    ...(options.choices?.model ? ["--model", options.choices.model] : []),
    ...(options.choices?.effort ? ["--effort", options.choices.effort] : []),
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
  await startRunnerPane(pane, options.cwd, options.prompt, (firstTurnFile) =>
    claudeSdkRunnerCommand({ ...options, start: "new", ...(firstTurnFile ? { firstTurnFile } : {}) }),
  );
  const tmuxSession = await adoptTitleName(pane, options.sessionId, options.title);
  return { sessionId: options.sessionId, title: options.title, tmuxSession };
}

/**
 * Forks a session into a new one in SDK mode, in a pane named for the fork.
 *
 * Through the SDK a fork from one of its source's messages is cut there as it starts
 * (`resumeSessionAt`), so its brief rides as the first turn -- behind the same standing note a
 * terminal fork gets, saying whose context it is holding.
 */
export async function startClaudeSdkForkedSession(options: {
  cwd: string;
  sessionId: string;
  forkId: string;
  title: string;
  brief?: string;
  resumeAt?: string;
}): Promise<StartedClaudeSession> {
  const pane = claudeForkPaneName(options.forkId);
  const firstTurn = options.brief ? forkFirstTurn(options.brief) : undefined;
  // Opened the way its source last ran, as a terminal fork is (`forkClaudeSessionCommand`).
  const selection = lastResumeSelection(options.sessionId);
  await startRunnerPane(pane, options.cwd, firstTurn, (firstTurnFile) =>
    claudeSdkRunnerCommand({
      sessionId: options.forkId,
      cwd: options.cwd,
      title: options.title,
      start: "fork",
      forkFrom: options.sessionId,
      choices: runnerChoicesOf(selection),
      ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}),
      ...(options.resumeAt ? { resumeAt: options.resumeAt } : {}),
      ...(firstTurnFile ? { firstTurnFile } : {}),
    }),
  );
  const tmuxSession = await adoptTitleName(pane, options.forkId, options.title);
  return { sessionId: options.forkId, title: options.title, tmuxSession };
}

/** A detached pane running a runner, its first turn handed over through a private file. */
async function startRunnerPane(
  pane: string,
  cwd: string,
  firstTurn: string | undefined,
  command: (firstTurnFile: string | undefined) => string[],
): Promise<void> {
  const directory = firstTurn ? await mkdtemp(join(tmpdir(), "agentdesk-first-turn-")) : null;
  try {
    const firstTurnFile = directory ? join(directory, "turn.txt") : undefined;
    if (firstTurnFile) await writeFile(firstTurnFile, firstTurn!, { mode: 0o600 });
    await createTmuxSession({
      session: pane,
      cwd,
      command: command(firstTurnFile),
      columns: UNATTENDED_COLUMNS,
      rows: UNATTENDED_ROWS,
    });
  } catch (error) {
    // The runner deletes the file once it has read it; when no runner started, nothing else will.
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * How a stopped session reopens: the way its newest record says it last ran, so a session switched
 * to the SDK comes back through the runner rather than as a terminal nobody asked for.
 */
export function lastRunMode(session: { lastEntrypoint?: string }): ClaudeRunMode {
  return session.lastEntrypoint === "sdk-cli" ? "sdk" : "terminal";
}

/** A selection's model and effort as a runner takes them at launch. */
function runnerChoicesOf(selection: ResumeSelection): RunnerChoices {
  return {
    ...(selection.model ? { model: selection.model } : {}),
    ...(isEffortLevel(selection.effort) ? { effort: selection.effort } : {}),
  };
}

/**
 * The argv that resumes a session in one mode or the other, with what it last ran with: so a model,
 * effort or mode chosen for a session stays the session's, whichever way it runs and however often
 * it restarts (`resumeSelection`).
 */
export function resumeCommandFor(
  mode: ClaudeRunMode,
  options: { sessionId: string; cwd: string; title: string; choices?: RunnerChoices },
): string[] {
  const selection = lastResumeSelection(options.sessionId, options.choices);
  return mode === "sdk"
    ? claudeSdkRunnerCommand({
        ...options,
        start: "resume",
        choices: runnerChoicesOf(selection),
        ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}),
      })
    : resumeClaudeSessionCommand(options.sessionId, selection);
}
