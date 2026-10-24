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
//
// The same move from SDK to SDK is how a stale runner is brought up to date (ADR-0144): a runner
// whose code is older than what is on disk is relaunched with `resume` the first time its session
// is idle, and left alone until then.

import type { ClaudeRunMode, ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { liveSessionProcesses, type ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import { currentProcessTable } from "@/tasks/processProbe";
import {
  findTmuxSessionByIdentity,
  respawnTmuxPane,
  tmuxPaneCommandExited,
  tmuxPaneStarts,
} from "@/terminal/tmux/tmuxSessions";
import type { ClaudeSdkClient } from "@/claude-sdk/session/claudeSdkClient";
import { resumeCommandFor } from "@/claude-sdk/claudeSdkLaunch";
import { isClaudeSdkRunnerCommand, type RunnerChoices } from "@/claude-sdk/claudeSdkProtocol";
import type { SessionReply } from "@/claude-sdk/session/claudeSdkCommands";
import { claudeDiffersFromInstalled } from "@/claude-sdk/session/claudeCodeVersions";
import { installedClaudeVersion } from "@/config/configBinaries";

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
  stopRunner(sessionId: string): Promise<SessionReply>;
  /** Ends a terminal session's `claude` the way closing its pane does, so it writes its exit records. */
  hangUp(pid: number): void;
  /** The stamped tmux session of this session, if any. */
  stamped(sessionId: string): Promise<string | null>;
  paneStarts(session: string): Promise<{ pane: string; command: string }[]>;
  /** Whether what the pane was started to run has exited, leaving its shell. */
  exited(pane: string): Promise<boolean>;
  respawn(pane: string, cwd: string, command: readonly string[]): Promise<void>;
  /** The model and effort an SDK session has chosen, read from its runner while it still answers. */
  runnerChoices(sessionId: string): Promise<RunnerChoices>;
  /** The command that resumes the session in a mode, with the choices a runner should keep. */
  resumeCommand(
    mode: ClaudeRunMode,
    options: { sessionId: string; cwd: string; title: string; choices?: RunnerChoices },
  ): string[];
  sleep(ms: number): Promise<void>;
  /** The CLI version a runner started now would run, or null when the install does not say. */
  installedClaude(): string | null;
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

/**
 * Why a runner that answers says its session is not idle, or null when it has no reason to.
 *
 * Only what the runner knows and the registry row may not yet say: a turn it has just been sent, a
 * question waiting on the reader, a background task. `starting` is no reason: it once lasted until
 * the CLI's `init`, which comes only with the first message, and every switch back out of a fresh
 * runner was refused (2026-10-18). It ends sooner now (`SdkSession.answered`), but whether a turn is
 * running stays the registry row's to say, as it is for a terminal.
 */
function runnerNotIdle(state: ClaudeSdkSessionState): string | null {
  if (state.status === "running" || state.status === "requires-action") return "a turn is running";
  if (state.pending.length > 0) return "a question or approval is waiting";
  if (state.backgroundTasks > 0) return "a background shell or agent is running, and it would end with the process";
  return null;
}

export async function switchRunMode(
  session: { sessionId: string; cwd: string; title: string },
  mode: ClaudeRunMode,
  steps: SwitchSteps,
): Promise<SwitchOutcome> {
  const { sessionId } = session;
  const live = await steps.processes(sessionId);
  if (live.length === 0) {
    return {
      ok: false,
      reason: "not-running",
      message: "this session is not running; opening it starts it the way it last ran",
    };
  }
  if (live.length > 1) {
    return {
      ok: false,
      reason: "several-processes",
      message: `${live.length} processes are running this session; close all but one first`,
    };
  }
  const process = live[0]!;
  const current = modeOf(process);
  if (current === null) {
    return {
      ok: false,
      reason: "not-ours",
      message: "this session is running outside the terminal and the SDK runner, so it can't be switched from here",
    };
  }
  if (current === mode)
    return {
      ok: false,
      reason: "already",
      message: `this session already runs ${mode === "sdk" ? "through the SDK" : "in the terminal"}`,
    };
  return moveInPane(session, process, current, mode, steps);
}

/**
 * Restarts an SDK session's runner on the code on disk now, resuming the same conversation in the
 * same pane. Refused for the reasons a switch is, and for a session not running through the SDK.
 */
export async function restartRunner(
  session: { sessionId: string; cwd: string; title: string },
  steps: SwitchSteps,
): Promise<SwitchOutcome> {
  const live = await steps.processes(session.sessionId);
  if (live.length !== 1) {
    return live.length === 0
      ? { ok: false, reason: "not-running", message: "this session is not running" }
      : { ok: false, reason: "several-processes", message: `${live.length} processes are running this session` };
  }
  const process = live[0]!;
  if (modeOf(process) !== "sdk")
    return { ok: false, reason: "not-ours", message: "this session is not running through the SDK" };
  return moveInPane(session, process, "sdk", "sdk", steps);
}

/** Stops the process in its pane once it is idle, and starts the session again there in `mode`. */
async function moveInPane(
  session: { sessionId: string; cwd: string; title: string },
  process: ClaudeSessionProcess,
  current: ClaudeRunMode,
  mode: ClaudeRunMode,
  steps: SwitchSteps,
): Promise<SwitchOutcome> {
  const { sessionId } = session;
  // Idle is the registry row's to say, in either mode: the CLI keeps it whoever holds the session,
  // and it reads `idle` the moment a turn ends. An SDK runner that answers can only add reasons.
  const state = current === "sdk" ? await steps.runnerState(sessionId) : null;
  const busy =
    (state?.connected ? runnerNotIdle(state) : null) ??
    (process.activity === "idle" ? null : (NOT_IDLE[process.activity ?? ""] ?? "it is not known to be idle"));
  if (busy) return { ok: false, reason: "busy", message: `not switched: ${busy}` };

  // Only a pane this sidecar started for this session, in the mode it is running now.
  const tmuxSession = await steps.stamped(sessionId);
  const pane = tmuxSession
    ? (await steps.paneStarts(tmuxSession)).find(
        ({ command }) => command.includes(sessionId) && (current === "sdk") === isClaudeSdkRunnerCommand(command),
      )
    : undefined;
  if (!pane) {
    return {
      ok: false,
      reason: "not-ours",
      message: "this session's pane was not started by this panel, so switching would end someone's shell",
    };
  }

  // Read before the runner stops, and only for a runner relaunched as one: what a session chose for
  // its model and effort it keeps, as it would have kept them had nothing restarted.
  const choices = current === "sdk" && mode === "sdk" && state?.connected ? await steps.runnerChoices(sessionId) : {};
  if (state?.connected) {
    const stopped = await steps.stopRunner(sessionId);
    if (!stopped.ok) return { ok: false, reason: "failed", message: `the runner would not stop: ${stopped.message}` };
  } else {
    // A terminal's `claude`, or one under a runner that does not answer: a hangup ends it the way
    // closing its pane does, and a runner whose `claude` has gone ends with it.
    steps.hangUp(process.pid);
  }
  // Polled, and bounded: the old process is not this sidecar's child, so its exit raises no event
  // here, and the wait is a few seconds of a process writing its exit records.
  for (let waited = 0; ; waited += STOP_POLL_MS) {
    const gone = (await steps.processes(sessionId)).length === 0 && (await steps.exited(pane.pane));
    if (gone) break;
    if (waited >= STOP_TIMEOUT_MS) {
      return { ok: false, reason: "failed", message: "the old process did not leave in time; nothing new was started" };
    }
    await steps.sleep(STOP_POLL_MS);
  }
  try {
    await steps.respawn(pane.pane, session.cwd, steps.resumeCommand(mode, { ...session, choices }));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "failed",
      message: `the session stopped, but starting it again failed (${why}); open it to resume it`,
    };
  }
  return { ok: true };
}

/** Sessions whose stale runner is being relaunched now, or was tried lately and refused. */
const relaunching = new Map<string, number>();
/** The one retry waiting for each session whose runner cannot say when it is idle. */
const retrying = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a refused relaunch waits before it is tried again on a later state. */
const RELAUNCH_RETRY_MS = 60_000;

/**
 * Relaunches a stale runner the first time its session is idle: no turn, nothing waiting, nothing
 * running in the background that would die with it. Called on every state such a runner sends,
 * which is how it notices the session going idle; anything short of that leaves it running.
 */
export function relaunchStaleRunner(
  client: ClaudeSdkClient,
  sessionId: string,
  state: ClaudeSdkSessionState,
  steps: SwitchSteps = liveSwitchSteps(client),
  now: () => number = Date.now,
  log: (line: string) => void = (line) => console.log(`[claude-sdk] ${line}`),
): Promise<SwitchOutcome | null> {
  // What a runner that answers knows is checked here; whether a turn is running is the registry
  // row's, asked inside the restart for every runner, which refuses while it is not idle.
  if (state.connected && runnerNotIdle(state) !== null) return Promise.resolve(null);
  const last = relaunching.get(sessionId);
  if (last !== undefined && now() - last < RELAUNCH_RETRY_MS) return Promise.resolve(null);
  relaunching.set(sessionId, now());
  return relaunchFromRow(client, sessionId, state, steps, now, log);
}

/**
 * The relaunch itself, where the session is and what it is called taken from its registry row: the
 * running process's own account, which the catalog may not have read yet.
 */
async function relaunchFromRow(
  client: ClaudeSdkClient,
  sessionId: string,
  state: ClaudeSdkSessionState,
  steps: SwitchSteps,
  now: () => number,
  log: (line: string) => void,
): Promise<SwitchOutcome | null> {
  const [row] = await steps.processes(sessionId);
  if (!row) {
    log(`${sessionId}: not relaunched: no process is running it`);
    return null;
  }
  const title = row.name ?? findSession("claude", sessionId)?.title ?? sessionId;
  const installed = steps.installedClaude();
  const why = claudeDiffersFromInstalled(state.claudeCodeVersion, installed)
    ? `it runs Claude Code ${state.claudeCodeVersion} and ${installed} is installed`
    : "its runner's code is older than what is on disk";
  log(`${sessionId}: relaunching its stale runner while it is idle: ${why}`);
  return restartRunner({ sessionId, cwd: row.cwd, title }, steps).then((outcome) => {
    if (outcome.ok) relaunching.delete(sessionId);
    else log(`${sessionId}: not relaunched: ${outcome.message}`);
    // A runner that answers says when it goes idle, and this is called again then. One on an older
    // protocol says nothing this sidecar can hear, and its registry row is a file the CLI rewrites
    // without an event held here, so a busy one is asked again after a while, until it is idle.
    if (!state.connected && !outcome.ok && outcome.reason === "busy" && !retrying.has(sessionId)) {
      const timer = setTimeout(() => {
        retrying.delete(sessionId);
        void relaunchStaleRunner(client, sessionId, state, steps, now, log);
      }, RELAUNCH_RETRY_MS);
      timer.unref?.();
      retrying.set(sessionId, timer);
    }
    return outcome;
  });
}

/** The steps against this machine: its registry, the runner's socket, tmux, and signals. */
export function liveSwitchSteps(client: ClaudeSdkClient): SwitchSteps {
  return {
    processes: async (sessionId) =>
      (await liveSessionProcesses(await currentProcessTable())).filter((entry) => entry.sessionId === sessionId),
    runnerState: (sessionId) => client.state(sessionId),
    runnerChoices: (sessionId) => client.choices(sessionId),
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
    installedClaude: installedClaudeVersion,
  };
}
