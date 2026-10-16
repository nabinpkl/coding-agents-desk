// Which running Claude sessions are behind what a fresh launch would give them, and restarting them.
//
// A session keeps two things from the moment its process started: the permission flags it was
// launched with (`configClaudeLaunch.ts`) and the CLI version that was installed then. Both move on
// without it -- the flags when the sidecar's launch changes, the version every time the CLI updates
// itself, which its own footer reports as "Restart to update". Restarting one session at a time is
// `restartClaudeSession`; this is the same restart for every session that needs it.
//
// What may be restarted is decided from the harness's own registry, not guessed from the pane:
// the CLI writes `status` there as its state moves, and only `idle` means nothing is running. A
// turn or a background agent is `busy`, a dialog is `waiting`, and a background shell that would
// die with the process is `shell`. Each is skipped and said so, never restarted. So is a session
// started with flags of its own (`panelLaunched`), which a restart under the panel's launch drops.

import type {
  ClaudeSessionActivity,
  StaleClaudeSession,
  StaleClaudeSessions,
  StaleSessionReason,
  StaleSessionRestartResult,
} from "@agentdesk/agent-feed-wire";
import { installedClaudeVersion } from "@/config/configBinaries";
import { claudeLaunchPermissionArgs } from "@/config/configClaudeLaunch";
import { currentProcessTable } from "@/tasks/processProbe";
import type { ProcessRow } from "@/tasks/processTable";
import { liveSessionProcesses, type ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import { launchedClaudePane } from "@/terminal/claudeSessionLaunch";

/**
 * How many restarts run at once. Each is a `claude --resume` loading its plugins and MCP servers,
 * and a wall of them starting in the same second is a machine-wide stall for every session left.
 */
const RESTARTS_AT_ONCE = 3;

export interface StaleSessionSources {
  /** The kernel's process table and the registry rows it vouches for, read together. */
  processes(): Promise<{ table: readonly ProcessRow[]; live: readonly ClaudeSessionProcess[] }>;
  installedVersion(): string | null;
  launchArgs: readonly string[];
  /**
   * The start command of the pane this sidecar launched for the session, or null when it runs in
   * no such pane -- the rule a restart obeys, so nothing is listed that the restart would refuse.
   */
  launchedPane(sessionId: string): Promise<string | null>;
}

export const liveStaleSessionSources: StaleSessionSources = {
  async processes() {
    const table = await currentProcessTable();
    return { table, live: await liveSessionProcesses(table) };
  },
  installedVersion: installedClaudeVersion,
  launchArgs: claudeLaunchPermissionArgs,
  async launchedPane(sessionId) {
    const pane = await launchedClaudePane(sessionId);
    return pane.kind === "pane" ? pane.startCommand : null;
  },
};

/**
 * Whether a process's command line carries every launch flag, a flag's value beside it.
 *
 * Order-free, because the CLI does not care and a launch that reorders them is not stale. Split on
 * whitespace, which is safe for the flags themselves; a title with spaces elsewhere in the command
 * only adds tokens nothing is looking for.
 */
export function launchedWithFlags(command: string, launchArgs: readonly string[]): boolean {
  const tokens = command.split(/\s+/);
  for (let index = 0; index < launchArgs.length; index += 1) {
    const flag = launchArgs[index]!;
    const value = launchArgs[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      index += 1;
      if (!tokens.some((token, at) => token === flag && tokens[at + 1] === value)) return false;
    } else if (!tokens.includes(flag)) {
      return false;
    }
  }
  return true;
}

/** The flags a launch from this sidecar's own paths can carry besides the permission flags. */
const PANEL_LAUNCH_FLAGS = ["--resume", "--fork-session", "--session-id", "-n"];

/**
 * The arguments a pane was started with, out of its start command.
 *
 * Read from the pane rather than from `ps`, because the pane's copy is exact: the sidecar quotes
 * each argument on its own (`'\\''claude'\\''` once tmux has printed it), and a first turn travels
 * through a file rather than the command line, so the arguments are the launch and nothing else.
 * `ps` joins argv with spaces, and a first turn that mentions `--print` reads there as a flag.
 * One backslash or two, since that is tmux's escaping rather than ours. A pane started by hand,
 * with no quoting, is split on whitespace with any stray quotes trimmed, so a flag still reads as
 * one rather than hiding behind a quote and passing as an argument.
 */
export function paneLaunchArguments(startCommand: string): string[] {
  const quoted = [...startCommand.matchAll(/'\\{1,2}''(.*?)'\\{1,2}''/g)].map((match) => match[1]!);
  // A hand-typed command is often several (`claude ...; exec /bin/zsh -l`), and the shell after it
  // is not the launch: read the one that runs `claude`, or all of them when none plainly does.
  const segment = startCommand.split(/;|&&|\|\|/).find((part) => /(^|[\s'"/])claude(['"]|\s|$)/.test(part))
    ?? startCommand;
  const words = quoted.length > 0
    ? quoted
    : segment.split(/\s+/).map((token) => token.replace(/^['"\\]+|['"\\]+$/g, "")).filter(Boolean);
  // From `claude` on: what comes before it is the pane's own plumbing, the first-turn wrapper's
  // `/bin/sh -c` among it. With no `claude` to find, everything is kept, flags and all.
  const claude = words.findIndex((word) => /(^|\/)claude$/.test(word));
  return claude === -1 ? words : words.slice(claude);
}

/**
 * Whether every flag a pane was launched with is one this sidecar's own launches use.
 *
 * A restart runs `claude <launch flags> --resume <id>`, so whatever else a session was started with
 * -- an arena lane's `--disallowedTools`, a probe's `--model` and `--tools` -- is gone after it.
 * Allowed rather than denied, because a flag nobody listed is exactly the one a denylist misses.
 */
export function panelLaunched(launchArguments: readonly string[], launchArgs: readonly string[]): boolean {
  const allowed = new Set([...PANEL_LAUNCH_FLAGS, ...launchArgs.filter((arg) => arg.startsWith("-"))]);
  return launchArguments.every((token) => !/^--?[A-Za-z]/.test(token) || allowed.has(token));
}

/**
 * The state of a session with more than one live process, read as its most active one.
 *
 * More than one row can claim one id (a resume beside a process still holding it), and a restart
 * replaces only the pane's: reading the quietest of them as the session's state would restart a
 * pane while the session was mid-turn somewhere else.
 */
const ACTIVITY_RANK: Record<ClaudeSessionActivity, number> = { idle: 0, shell: 1, waiting: 2, busy: 3 };

export function sessionActivity(processes: readonly ClaudeSessionProcess[]): ClaudeSessionActivity | null {
  let most: ClaudeSessionActivity | null = null;
  for (const { activity } of processes) {
    // An unknown status is not known to be idle, and must not read as idle by losing to one that is.
    if (activity === null) return null;
    if (most === null || ACTIVITY_RANK[activity] > ACTIVITY_RANK[most]) most = activity;
  }
  return most;
}

/** Why a session was left running, in the reader's terms rather than the registry's. */
const NOT_IDLE: Record<Exclude<ClaudeSessionActivity, "idle"> | "unknown", string> = {
  busy: "a turn is running",
  waiting: "a dialog is open",
  shell: "a background shell is running",
  unknown: "not known to be idle",
};

export async function listStaleSessions(sources: StaleSessionSources): Promise<StaleClaudeSessions> {
  const { table, live } = await sources.processes();
  const installedVersion = sources.installedVersion();
  const commands = new Map(table.map((row) => [row.pid, row.command]));
  const bySession = new Map<string, ClaudeSessionProcess[]>();
  // A process outside tmux has no pane to restart in: a Desktop window, a terminal of its own.
  for (const process of live) {
    if (process.tmuxSession === null) continue;
    bySession.set(process.sessionId, [...bySession.get(process.sessionId) ?? [], process]);
  }
  const sessions: StaleClaudeSession[] = [];
  for (const [sessionId, processes] of bySession) {
    const reasons = new Set<StaleSessionReason>();
    for (const process of processes) {
      const command = commands.get(process.pid);
      if (command !== undefined && !launchedWithFlags(command, sources.launchArgs)) reasons.add("launch-flags");
      if (installedVersion !== null && process.version !== null && process.version !== installedVersion) {
        reasons.add("update");
      }
    }
    if (reasons.size === 0) continue;
    const startCommand = await sources.launchedPane(sessionId);
    if (startCommand === null) continue;
    const first = processes[0]!;
    sessions.push({
      sessionId,
      name: first.name,
      version: first.version,
      activity: sessionActivity(processes),
      reasons: [...reasons],
      ownLaunch: !panelLaunched(paneLaunchArguments(startCommand), sources.launchArgs),
    });
  }
  sessions.sort((a, b) => (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId));
  return { installedVersion, sessions };
}

/**
 * Restarts the sessions the reader agreed to, as each one stands at the moment of its restart.
 *
 * The list is read again rather than trusted from the request, so a session that stopped being
 * stale, or stopped running, in the seconds the reader spent deciding is skipped. Its state is
 * read again immediately before each restart, because a message can start a turn in between and
 * the restart would end it. One result per id asked for, in the order asked, and one failure does
 * not stop the rest.
 */
export async function restartStaleSessions(
  sessionIds: readonly string[],
  sources: StaleSessionSources & { restart(sessionId: string): Promise<void> },
): Promise<StaleSessionRestartResult[]> {
  const stale = new Map((await listStaleSessions(sources)).sessions.map((session) => [session.sessionId, session]));
  const ids = [...new Set(sessionIds)];
  const results = new Map<string, StaleSessionRestartResult>();

  const restartOne = async (sessionId: string): Promise<StaleSessionRestartResult> => {
    const session = stale.get(sessionId);
    const name = session?.name ?? null;
    if (!session) {
      return { sessionId, name, outcome: { kind: "skipped", reason: "no longer stale, or no longer running in a panel pane" } };
    }
    if (session.ownLaunch) {
      return { sessionId, name, outcome: { kind: "skipped", reason: "launched with flags of its own, which a restart would drop" } };
    }
    const { live } = await sources.processes();
    const processes = live.filter((process) => process.sessionId === sessionId);
    if (processes.length === 0) return { sessionId, name, outcome: { kind: "skipped", reason: "no longer running" } };
    const activity = sessionActivity(processes);
    if (activity !== "idle") return { sessionId, name, outcome: { kind: "skipped", reason: NOT_IDLE[activity ?? "unknown"] } };
    try {
      await sources.restart(sessionId);
      return { sessionId, name, outcome: { kind: "restarted" } };
    } catch (error) {
      return { sessionId, name, outcome: { kind: "failed", message: error instanceof Error ? error.message : String(error) } };
    }
  };

  const queue = [...ids];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) results.set(id, await restartOne(id));
  };
  await Promise.all(Array.from({ length: Math.min(RESTARTS_AT_ONCE, ids.length) }, worker));
  return ids.map((id) => results.get(id)!);
}
