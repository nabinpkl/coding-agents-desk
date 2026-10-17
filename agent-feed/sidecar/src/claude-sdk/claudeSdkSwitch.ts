// Moving a running Claude session between the terminal and the SDK runner, while it is idle.
//
// One process per session, always (ADR-0143). Two `claude` processes on one session keep two copies
// of the conversation and fork its transcript -- measured -- so the switch never overlaps them: it
// stops the one that is running, waits until the registry no longer lists it and its pane is back
// at its shell, and only then starts the other mode in that same pane. Viewers stay attached through
// it, because `respawn-pane` keeps the pane, its pipe and its stamp.
//
// Refused rather than forced whenever it would cost something: a turn running, a question or
// approval waiting, a background shell or agent alive inside the process (it dies with it), more
// than one process already, or a pane this sidecar did not start (respawning it would end
// somebody's own shell).

import type { ClaudeRunMode, ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { liveSessionProcesses, type ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import { currentProcessTable } from "@/tasks/processProbe";
import {
  findTmuxSessionByIdentity,
  respawnTmuxPane,
  tmuxPaneCommandExited,
  tmuxPaneStarts,
} from "@/terminal/tmux/tmuxSessions";
import type { ClaudeSdkClient } from "@/claude-sdk/claudeSdkClient";
import { resumeCommandFor } from "@/claude-sdk/claudeSdkLaunch";
import { isClaudeSdkRunnerCommand, type RunnerReply } from "@/claude-sdk/claudeSdkProtocol";

export type SwitchRefusal =
  /** No process holds the session; opening it starts it, in the mode it last ran in. */
  | "not-running"
  /** More than one process holds it already, which is the state the switch exists to prevent. */
  | "several-processes"
  /** It runs somewhere that is neither of the two modes: a Desktop window, or someone's own pane. */
  | "not-ours"
  | "already"
  /** Not idle, for the reason the message says. */
  | "busy"
  /** The steps themselves failed partway; the message says where it was left. */
  | "failed";

export type SwitchOutcome = { ok: true } | { ok: false; reason: SwitchRefusal; message: string };

export interface SwitchSteps {
  /** Every live registry row for this session. */
  processes(sessionId: string): Promise<ClaudeSessionProcess[]>;
  /** The runner's state, connecting to ask; `connected: false` when none answers. */
  runnerState(sessionId: string): Promise<ClaudeSdkSessionState>;
  stopRunner(sessionId: string): Promise<RunnerReply>;
  /** Ends a terminal session's `claude` the way closing its pane does, so it writes its exit records. */
  hangUp(pid: number): void;
  /** The stamped tmux session of this session, if any. */
  stamped(sessionId: string): Promise<string | null>;
  paneStarts(session: string): Promise<{ pane: string; command: string }[]>;
  /** Whether what the pane was started to run has exited, leaving its shell. */
  exited(pane: string): Promise<boolean>;
  respawn(pane: string, cwd: string, command: readonly string[]): Promise<void>;
  /** The command that resumes the session in a mode. */
  resumeCommand(mode: ClaudeRunMode, options: { sessionId: string; cwd: string; title: string }): string[];
  sleep(ms: number): Promise<void>;
}

/** How long the old process gets to write its exit records and leave before the switch gives up. */
const STOP_TIMEOUT_MS = 20_000;
const STOP_POLL_MS = 250;

/** The mode a live row says its process runs in, or null for a process that is neither. */
function modeOf(process: ClaudeSessionProcess): ClaudeRunMode | null {
  return process.entrypoint === "sdk-cli" ? "sdk" : process.entrypoint === "cli" ? "terminal" : null;
}

const NOT_IDLE: Record<string, string> = {
  busy: "a turn is running",
  waiting: "a dialog is open",
  shell: "a background shell is running, and it would end with the process",
};

export async function switchRunMode(
  session: { sessionId: string; cwd: string; title: string },
  mode: ClaudeRunMode,
  steps: SwitchSteps,
): Promise<SwitchOutcome> {
  const { sessionId } = session;
  const live = await steps.processes(sessionId);
  if (live.length === 0) {
    return { ok: false, reason: "not-running", message: "this session is not running; opening it starts it the way it last ran" };
  }
  if (live.length > 1) {
    return { ok: false, reason: "several-processes", message: `${live.length} processes are running this session; close all but one first` };
  }
  const process = live[0]!;
  const current = modeOf(process);
  if (current === null) {
    return { ok: false, reason: "not-ours", message: "this session is running outside the terminal and the SDK runner, so it can't be switched from here" };
  }
  if (current === mode) return { ok: false, reason: "already", message: `this session already runs ${mode === "sdk" ? "through the SDK" : "in the terminal"}` };

  // Idle, asked of whoever knows: the runner for an SDK session, the registry row for a terminal one.
  if (current === "sdk") {
    const state = await steps.runnerState(sessionId);
    const busy = !state.connected
      ? "its runner is not answering"
      : state.status !== "idle"
        ? "a turn is running"
        : state.pending.length > 0
          ? "a question or approval is waiting"
          : state.backgroundTasks > 0
            ? "a background shell or agent is running, and it would end with the process"
            : null;
    if (busy) return { ok: false, reason: "busy", message: `not switched: ${busy}` };
  } else if (process.activity !== "idle") {
    return { ok: false, reason: "busy", message: `not switched: ${NOT_IDLE[process.activity ?? ""] ?? "it is not known to be idle"}` };
  }

  // Only a pane this sidecar started for this session, in the mode it is running now.
  const tmuxSession = await steps.stamped(sessionId);
  const pane = tmuxSession
    ? (await steps.paneStarts(tmuxSession)).find(({ command }) =>
      command.includes(sessionId) && (current === "sdk") === isClaudeSdkRunnerCommand(command))
    : undefined;
  if (!pane) {
    return { ok: false, reason: "not-ours", message: "this session's pane was not started by this panel, so switching would end someone's shell" };
  }

  if (current === "sdk") {
    const stopped = await steps.stopRunner(sessionId);
    if (!stopped.ok) return { ok: false, reason: "failed", message: `the runner would not stop: ${stopped.message}` };
  } else {
    steps.hangUp(process.pid);
  }
  // Polled, and bounded: the old process is not this sidecar's child, so its exit raises no event
  // here, and the wait is a few seconds of a process writing its exit records.
  for (let waited = 0; ; waited += STOP_POLL_MS) {
    const gone = (await steps.processes(sessionId)).length === 0 && await steps.exited(pane.pane);
    if (gone) break;
    if (waited >= STOP_TIMEOUT_MS) {
      return { ok: false, reason: "failed", message: "the old process did not leave in time; nothing new was started" };
    }
    await steps.sleep(STOP_POLL_MS);
  }
  try {
    await steps.respawn(pane.pane, session.cwd, steps.resumeCommand(mode, session));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "failed", message: `the session stopped, but starting it again failed (${why}); open it to resume it` };
  }
  return { ok: true };
}

/** The steps against this machine: its registry, the runner's socket, tmux, and signals. */
export function liveSwitchSteps(client: ClaudeSdkClient): SwitchSteps {
  return {
    processes: async (sessionId) =>
      (await liveSessionProcesses(await currentProcessTable())).filter((entry) => entry.sessionId === sessionId),
    runnerState: (sessionId) => client.state(sessionId),
    stopRunner: (sessionId) => client.command(sessionId, { type: "stop" }),
    hangUp: (pid) => {
      // The registry vouched for this pid against the kernel's start time a moment ago.
      process.kill(pid, "SIGHUP");
    },
    stamped: findTmuxSessionByIdentity,
    paneStarts: tmuxPaneStarts,
    exited: tmuxPaneCommandExited,
    respawn: respawnTmuxPane,
    resumeCommand: resumeCommandFor,
    sleep: (ms) => Bun.sleep(ms),
  };
}
