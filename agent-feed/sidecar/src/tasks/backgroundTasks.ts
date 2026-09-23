// One session's background work, assembled from the three sources that each know part of it.
//
//   the kernel      which tasks are running, and where their output really goes
//   the .output file how a task ended, including the kills nothing else records
//   the transcript  what the agent said it was starting
//
// The ordering here is the correction the live smoke forced. Asking the transcript first produced
// a list where two of four finished tasks were still shown as running, forever, because a killed
// task emits no completion record. So the kernel leads and the transcript only supplies words.

import { stat } from "node:fs/promises";
import type {
  AgentRunDetail,
  BackgroundTask,
  BackgroundTaskSnapshot,
  RunningBackgroundTask,
  TaskActivity,
} from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import {
  busiestDescendant,
  isInsideTaskRoot,
  matchShellsByCommand,
  type ProcessRow,
  shellDetailFrom,
  type TaskShell,
} from "@/tasks/processProbe";
import {
  type AgentIdentity,
  claudeTranscriptPath,
  type MonitorIdentity,
  scanSessionTasks,
  type TaskIdentity,
} from "@/tasks/taskIdentity";
import type { ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import { parseTerminalMarker, resolveTaskState, type TaskNotification } from "@/tasks/taskState";

/** Enough to hold the marker, which is the last thing in the file. */
const MARKER_TAIL_BYTES = 256;

/** How much of a descendant's argv crosses to the panel. Enough to identify a step, not a script. */
const ACTIVITY_COMMAND_LIMIT = 300;

function activityOf(row: ProcessRow, now: number): TaskActivity {
  return {
    pid: row.pid,
    command: row.command.slice(0, ACTIVITY_COMMAND_LIMIT),
    cpuMs: row.cpuMs,
    elapsedMs: Math.max(0, now - row.startedAt),
  };
}

export async function readTerminalMarker(path: string): Promise<ReturnType<typeof parseTerminalMarker>> {
  if (!isInsideTaskRoot(path)) return null;
  try {
    const file = Bun.file(path);
    const size = file.size;
    const tail = await file.slice(Math.max(0, size - MARKER_TAIL_BYTES), size).text();
    return parseTerminalMarker(tail);
  } catch {
    // Reaped, or never existed. Absence is evidence of nothing, and `resolveTaskState` treats it
    // that way rather than inventing an outcome.
    return null;
  }
}

export interface SnapshotSources {
  shells: readonly TaskShell[];
  identities: ReadonlyMap<string, TaskIdentity>;
  notifications: ReadonlyMap<string, TaskNotification>;
  markers: ReadonlyMap<string, ReturnType<typeof parseTerminalMarker>>;
  captureSizes: ReadonlyMap<string, number>;
  /**
   * The machine's process table, or empty when no shell needed one.
   *
   * Serves two questions from one fork: a task shell's own argv, for shells the transcript cannot
   * account for, and each task's descendant tree, for what it is executing now.
   */
  processes: readonly ProcessRow[];
  /** Monitor watchers the transcript recorded, keyed by task id. */
  monitors: ReadonlyMap<string, MonitorIdentity>;
  /** Subagents the transcript recorded, keyed by agent id. */
  agents: ReadonlyMap<string, AgentIdentity>;
  /** The pid whose direct children are this session's task shells. */
  ownerPid: number;
  /** How long an uncorroborated shell must have run before it is shown. */
  uncorroboratedAfterMs: number;
  ownerAlive: boolean;
  now: number;
}

/**
 * Fold the three sources into what the panel renders. Pure, so the precedence is testable without
 * a live session.
 *
 * A shell corroborated by a transcript start record is a background task, immediately and without
 * qualification. That corroboration is not bookkeeping, it is the discriminator: the harness gives
 * FOREGROUND commands a `tasks/<id>.output` file too and their shells hold it open exactly the same
 * way -- same descriptor, same process group, same state -- so the kernel cannot tell the two
 * apart. Reporting every live shell showed the agent's own in-flight `curl` as a background task.
 *
 * But requiring corroboration alone hid a case worth seeing. A command PROMOTED to the background
 * after it started -- by the operator, or by the harness's own foreground timeout -- carries no
 * `run_in_background` in its tool_use, and the tool_result that would name its task id does not
 * exist until the command ends. Measured on a live session: a six-minute run that the harness's own
 * panel listed under Running was, on disk, indistinguishable from a foreground command for its
 * entire life. Waiting for corroboration means showing it only once it no longer matters.
 *
 * So an uncorroborated shell is shown once it has outlived `uncorroboratedAfterMs`, and is marked
 * `corroborated: false` so the panel can say which kind of knowledge it is. The threshold is a
 * heuristic, not a discriminator -- a foreground command that runs longer will appear too. That is
 * the accepted cost of the alternative being a task nobody can see.
 *
 * Monitors are found a third way, because neither of the first two reaches them. A Monitor's shell
 * holds a socket pair instead of a capture file -- the harness reads each line as it is written and
 * turns it into a notification -- so no descriptor names it and no threshold applies. What the
 * transcript does record is its command, verbatim, and the harness runs that command verbatim, so
 * the command is the join. Measured: two watchers the harness's own panel listed as running were
 * invisible here for their whole lives.
 */
/** The wire's view of a run, which is the identity minus what only the sidecar needs. */
function detailOf(agent: AgentIdentity): AgentRunDetail {
  return {
    subagentType: agent.subagentType,
    model: agent.model,
    resolvedModel: agent.resolvedModel,
    launchedAsync: agent.launchedAsync,
  };
}

export function assembleSnapshot(sources: SnapshotSources): BackgroundTaskSnapshot {
  const running: RunningBackgroundTask[] = [];
  const finished: BackgroundTask[] = [];
  const liveIds = new Set(sources.shells.map((shell) => shell.taskId));
  const seen = new Set<string>();

  const describe = (taskId: string): Pick<BackgroundTask, "description" | "command" | "startedAt"> => {
    const identity = sources.identities.get(taskId);
    if (identity) {
      return {
        description: identity.description,
        command: identity.command,
        startedAt: identity.startedAt,
      };
    }
    const watcher = sources.monitors.get(taskId);
    if (watcher) {
      return {
        description: watcher.description,
        command: watcher.command,
        startedAt: watcher.startedAt,
      };
    }
    const agent = sources.agents.get(taskId);
    if (agent) {
      return { description: agent.description, command: null, startedAt: agent.startedAt };
    }
    const notification = sources.notifications.get(taskId);
    return {
      description: notification?.summary || taskId,
      command: null,
      startedAt: null,
    };
  };

  for (const shell of sources.shells) {
    const corroborated = sources.identities.has(shell.taskId);
    let identity: Pick<BackgroundTask, "description" | "command" | "startedAt">;
    if (corroborated) {
      identity = describe(shell.taskId);
    } else {
      // Without a start record the only clock is the shell's own, and without that there is
      // nothing to measure the threshold against -- so it is dropped rather than shown at age
      // zero, which would defeat the threshold for exactly the shells we know least about.
      const detail = shellDetailFrom(sources.processes, shell.pid);
      if (!detail) continue;
      if (sources.now - detail.startedAt < sources.uncorroboratedAfterMs) continue;
      // No agent words exist for this one, so the command line stands in. It is uglier and it is
      // always true, which is the right trade for a row the panel is already qualifying.
      identity = {
        description: detail.command,
        command: detail.command,
        startedAt: detail.startedAt,
      };
    }
    seen.add(shell.taskId);
    const captureSize = sources.captureSizes.get(shell.taskId) ?? 0;
    const busiest = busiestDescendant(sources.processes, shell.pid);
    running.push({
      ...identity,
      taskId: shell.taskId,
      kind: "bash",
      state: { status: "running" },
      elapsedMs: identity.startedAt === null ? 0 : Math.max(0, sources.now - identity.startedAt),
      hasOutput: captureSize > 0,
      corroborated,
      activity: busiest === null ? null : activityOf(busiest, sources.now),
    });
  }

  // Monitors, which no descriptor can find. Their shells hold a socket pair rather than a capture
  // file, so they are located by the command the transcript recorded instead.
  const watchers = [...sources.monitors.values()];
  const watcherShells = matchShellsByCommand(
    sources.processes,
    sources.ownerPid,
    watchers.map((watcher) => ({
      key: watcher.taskId,
      command: watcher.command,
      startedAt: watcher.startedAt,
    })),
  );
  for (const watcher of watchers) {
    const shell = watcherShells.get(watcher.taskId);
    // No live shell running that command means the watcher is over -- it hit its deadline, or was
    // stopped. It falls through to the loop below, which lists it as finished.
    if (!shell) continue;
    seen.add(watcher.taskId);
    const busiest = busiestDescendant(sources.processes, shell.pid);
    running.push({
      taskId: watcher.taskId,
      kind: "monitor",
      description: watcher.description,
      command: watcher.command,
      startedAt: watcher.startedAt,
      state: { status: "running" },
      elapsedMs: Math.max(0, sources.now - shell.startedAt),
      // A Monitor's output is its notifications, not a file. Saying it has output would promise a
      // stream that resolves to nothing.
      hasOutput: false,
      corroborated: true,
      activity: busiest === null ? null : activityOf(busiest, sources.now),
    });
  }

  // Subagents, which no descriptor and no command can find. A subagent has no shell at all: it
  // runs inside the session's own process, so the kernel has nothing to say about it and the two
  // joins above are both unavailable. Its evidence is entirely the transcript -- launched, and no
  // completion recorded yet -- which is exactly why the missing notification shape had to be
  // fixed first. Without that, every subagent ever launched would read as running forever.
  for (const [agentId, agent] of sources.agents) {
    if (seen.has(agentId)) continue;
    const notification = sources.notifications.get(agentId);
    if (notification?.kind === "completion") continue;
    // A synchronous subagent's result only exists once it is over, so a launch record with no
    // completion cannot mean "running" for one. It falls through to `finished` below.
    if (!agent.launchedAsync) continue;
    seen.add(agentId);
    running.push({
      taskId: agentId,
      kind: "agent",
      agent: detailOf(agent),
      description: agent.description,
      command: null,
      startedAt: agent.startedAt,
      state: { status: "running" },
      elapsedMs: agent.startedAt === null ? 0 : Math.max(0, sources.now - agent.startedAt),
      // Its readable trace is a transcript on its own route, not bytes on the task output stream.
      // Claiming output here would open a stream that resolves to nothing.
      hasOutput: false,
      corroborated: true,
      // No process, so nothing to report. Null is the truth rather than a gap.
      activity: null,
    });
  }

  const candidates = new Set<string>([
    ...sources.identities.keys(),
    ...sources.monitors.keys(),
    ...sources.agents.keys(),
    ...sources.notifications.keys(),
  ]);
  for (const taskId of candidates) {
    if (seen.has(taskId)) continue;
    const notification = sources.notifications.get(taskId) ?? null;
    // A progress tick means the task was alive when it fired and says nothing about now, so on its
    // own it cannot close a task -- that rule exists because a Monitor emits many of them over its
    // life and treating any as a completion retired a watcher that was still watching.
    //
    // It no longer applies to a watcher we can actually look up. A Monitor in `monitors` that
    // reached this loop was not matched to a live shell above, which means nothing is running its
    // command: it is over, whatever its last tick said, and it belongs in `finished` rather than
    // disappearing from both lists.
    if (
      notification?.kind === "progress" &&
      !sources.identities.has(taskId) &&
      !sources.monitors.has(taskId)
    ) {
      continue;
    }
    const state = resolveTaskState({
      holdsOutputOpen: liveIds.has(taskId),
      marker: sources.markers.get(taskId) ?? null,
      notification,
    });
    if (state.status === "running") continue;
    finished.push({
      ...describe(taskId),
      taskId,
      kind: sources.monitors.has(taskId)
        ? "monitor"
        // A launch record is stronger evidence than a notification's tags: it says what this run
        // WAS, where the tags only say what its ending looked like. A completion whose notification
        // aged out of the window would otherwise demote a finished subagent to a shell.
        : sources.agents.has(taskId)
        ? "agent"
        : notification?.kind === "completion"
        ? notification.taskKind
        : "bash",
      ...(sources.agents.has(taskId)
        ? { agent: detailOf(sources.agents.get(taskId)!) }
        : {}),
      state,
    });
  }

  running.sort((left, right) => right.elapsedMs - left.elapsedMs);
  finished.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  return { running, finished, ownerAlive: sources.ownerAlive };
}

/**
 * The live snapshot for one Claude session, given what the kernel already said about it.
 *
 * The kernel facts arrive as arguments rather than being fetched here, because they are the part
 * every subscribed session shares: one process table and one `lsof` answer for the whole tick,
 * gathered by `backgroundTaskCoordinator`. What is left below is genuinely per-session -- this
 * session's transcript, this session's capture files -- and none of it forks.
 *
 * A null `owner` is an empty, `ownerAlive: false` snapshot: without a live process there is
 * nothing to run a background task, so the files are not read at all rather than read against a
 * pid that means something else now.
 */
export async function backgroundTaskSnapshot(
  sessionId: string,
  kernel: {
    owner: ClaudeSessionProcess | null;
    shells: readonly TaskShell[];
    table: readonly ProcessRow[];
  },
  now: number = Date.now(),
): Promise<BackgroundTaskSnapshot> {
  const { owner, shells, table } = kernel;
  if (!owner) return { running: [], finished: [], ownerAlive: false };

  const transcriptPath = await claudeTranscriptPath(sessionId);
  const scan = transcriptPath
    ? await scanSessionTasks(sessionId, transcriptPath, new Set(shells.map((shell) => shell.taskId)))
    : {
      starts: new Map<string, TaskIdentity>(),
      monitors: new Map<string, MonitorIdentity>(),
      agents: new Map<string, AgentIdentity>(),
      notifications: new Map<string, TaskNotification>(),
    };

  const markers = new Map<string, ReturnType<typeof parseTerminalMarker>>();
  const captureSizes = new Map<string, number>();
  const liveIds = new Set(shells.map((shell) => shell.taskId));
  for (const [taskId, identity] of scan.starts) {
    if (liveIds.has(taskId)) {
      captureSizes.set(taskId, await fileSize(identity.capturePath));
      continue;
    }
    markers.set(taskId, await readTerminalMarker(identity.capturePath));
  }
  for (const shell of shells) {
    if (!captureSizes.has(shell.taskId)) {
      captureSizes.set(shell.taskId, await fileSize(shell.capturePath));
    }
  }

  // A Monitor holds no capture file, so a session can have watchers running with no `shells` at
  // all -- the table is needed whenever either could be live. It is already in hand, so the
  // question is only whether to hand it on, not whether to fetch it.
  const processes = shells.length === 0 && scan.monitors.size === 0 ? [] : table;

  return assembleSnapshot({
    shells,
    identities: scan.starts,
    notifications: scan.notifications,
    markers,
    captureSizes,
    processes,
    monitors: scan.monitors,
    agents: scan.agents,
    ownerPid: owner.pid,
    uncorroboratedAfterMs: config.backgroundTaskUncorroboratedMs,
    ownerAlive: true,
    now,
  });
}

async function fileSize(path: string): Promise<number> {
  if (!isInsideTaskRoot(path)) return 0;
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
