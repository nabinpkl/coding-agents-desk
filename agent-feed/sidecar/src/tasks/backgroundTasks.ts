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
  BackgroundTask,
  BackgroundTaskSnapshot,
  RunningBackgroundTask,
} from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import {
  type CommandRunner,
  isInsideTaskRoot,
  runCommand,
  type ShellDetail,
  shellDetailsOf,
  type TaskShell,
  taskShellsOf,
} from "./processProbe.ts";
import { claudeTranscriptPath, scanSessionTasks, type TaskIdentity } from "./taskIdentity.ts";
import { sessionOwner } from "./sessionRegistry.ts";
import { parseTerminalMarker, resolveTaskState, type TaskNotification } from "./taskState.ts";

/** Enough to hold the marker, which is the last thing in the file. */
const MARKER_TAIL_BYTES = 256;

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
  /** Kernel-side identity for shells the transcript cannot account for, keyed by shell pid. */
  shellDetails: ReadonlyMap<number, ShellDetail>;
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
 */
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
      const detail = sources.shellDetails.get(shell.pid);
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
    running.push({
      ...identity,
      taskId: shell.taskId,
      kind: "bash",
      state: { status: "running" },
      elapsedMs: identity.startedAt === null ? 0 : Math.max(0, sources.now - identity.startedAt),
      hasOutput: captureSize > 0,
      corroborated,
    });
  }

  const candidates = new Set<string>([...sources.identities.keys(), ...sources.notifications.keys()]);
  for (const taskId of candidates) {
    if (seen.has(taskId)) continue;
    const notification = sources.notifications.get(taskId) ?? null;
    // A Monitor watcher that has only ticked is neither running (no shell holds an output file)
    // nor over. Listing it as finished would claim an ending that has not happened.
    if (notification?.kind === "progress" && !sources.identities.has(taskId)) continue;
    const state = resolveTaskState({
      holdsOutputOpen: liveIds.has(taskId),
      marker: sources.markers.get(taskId) ?? null,
      notification,
    });
    if (state.status === "running") continue;
    finished.push({
      ...describe(taskId),
      taskId,
      kind: notification?.kind === "completion" ? notification.taskKind : "bash",
      state,
    });
  }

  running.sort((left, right) => right.elapsedMs - left.elapsedMs);
  finished.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  return { running, finished, ownerAlive: sources.ownerAlive };
}

/**
 * The live snapshot for one Claude session.
 *
 * Returns an empty, `ownerAlive: false` snapshot when no live process is serving the session --
 * without one there is nothing to run a background task, so the probe is skipped entirely rather
 * than run against a pid that means something else now.
 */
export async function backgroundTaskSnapshot(
  sessionId: string,
  run: CommandRunner = runCommand,
  now: number = Date.now(),
): Promise<BackgroundTaskSnapshot> {
  const owner = await sessionOwner(sessionId, run);
  if (!owner) return { running: [], finished: [], ownerAlive: false };

  const shells = await taskShellsOf(run, owner.pid);
  const transcriptPath = await claudeTranscriptPath(sessionId);
  const scan = transcriptPath
    ? await scanSessionTasks(sessionId, transcriptPath, new Set(shells.map((shell) => shell.taskId)))
    : { starts: new Map<string, TaskIdentity>(), notifications: new Map<string, TaskNotification>() };

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

  // Only the shells the transcript could not account for. In the ordinary case that set is empty
  // and this costs no fork at all; it is the promoted-task case that pays for one.
  const unaccounted = shells
    .filter((shell) => !scan.starts.has(shell.taskId))
    .map((shell) => shell.pid);

  return assembleSnapshot({
    shells,
    identities: scan.starts,
    notifications: scan.notifications,
    markers,
    captureSizes,
    shellDetails: await shellDetailsOf(run, unaccounted),
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
