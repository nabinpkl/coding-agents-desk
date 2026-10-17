// A session's background tasks, pushed while someone is looking.
//
// Its own stream rather than a field on the timeline, for a specific reason: the timeline
// remounts when the viewer toggles between raw and nice, and a task that has been running for
// eleven minutes should not restart its elapsed clock because someone changed how the transcript
// is rendered. The two facts have different lifetimes, so they get different streams.
//
// Nothing polls unless a subscriber is attached. An idle panel costs nothing.

import { basename } from "node:path";
import type { BackgroundTaskSnapshot, TaskOutputMessage } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { backgroundTasks } from "@/tasks/backgroundTaskCoordinator";
import { readTerminalMarker } from "@/tasks/backgroundTasks";
import {
  lastLines,
  OutputProgress,
  snapshotOffset,
  trimPartialFirstLine,
} from "@/tasks/outputFollower";
import {
  currentProcessTable,
  isInsideTaskRoot,
  outputTargetsOf,
  runCommand,
  taskShellsByOwner,
} from "@/tasks/processProbe";
import { sessionOwner } from "@/tasks/sessionRegistry";
import { claudeTranscriptPath, scanSessionTasks } from "@/tasks/taskIdentity";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const TASKS_ROUTE = /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/tasks$/;
const TASK_OUTPUT_ROUTE =
  /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/tasks\/([A-Za-z0-9]{1,64})\/output$/;

/** How much of the tail a newly opened stream shows, in bytes and then in lines. */
const SNAPSHOT_WINDOW_BYTES = 64 * 1024;
const SNAPSHOT_LINES = 200;

/**
 * Detection is Claude-shaped: it reads the harness's session registry and its task-output layout.
 *
 * A non-Claude session answers with an empty snapshot and `ownerAlive: false` rather than a 404,
 * because "we cannot see this source's background work" is exactly what that pair means, and the
 * panel already renders it as "no chip". A Codex adapter would slot in here without a wire change.
 */
const EMPTY: BackgroundTaskSnapshot = { running: [], finished: [], ownerAlive: false, ownerWaiting: false };

/**
 * Which file a task's output is actually going to.
 *
 * **The path is discovered, never supplied**, and what makes it safe is its PROVENANCE, not its
 * location. A caller cannot name a file: this endpoint is reachable from a phone and a path
 * parameter would make it a read oracle over everything the sidecar can open (ADR-0099).
 *
 * For a running task the path comes from the kernel -- the task's own shell and descendants are
 * asked what they hold open on fd 1. Those answers are trusted wherever they point, and they must
 * be: a command that redirects into `/tmp/build.log` is the case this feature exists for, and
 * fencing the result to the harness's task directory would refuse exactly it.
 *
 * The transcript fallback is the one path we did NOT watch a process open, so it is fenced.
 */
interface OutputTarget {
  /** What to stream. May be anywhere, when the kernel says the task is writing there. */
  path: string;
  /** The harness's own capture, which is where the terminal marker is written. */
  capturePath: string;
  running: boolean;
}

async function resolveOutputTarget(sessionId: string, taskId: string): Promise<OutputTarget | null> {
  const table = await currentProcessTable(runCommand);
  const owner = await sessionOwner(sessionId, table);
  if (owner) {
    const byOwner = await taskShellsByOwner(runCommand, [owner.pid], table);
    const shell = (byOwner.get(owner.pid) ?? []).find((entry) => entry.taskId === taskId);
    if (shell) {
      const targets = await outputTargetsOf(runCommand, shell);
      // Prefer where the work is really going; fall back to the capture, which is the right
      // answer for a task that simply prints to stdout.
      return {
        path: targets[0] ?? shell.capturePath,
        capturePath: shell.capturePath,
        running: true,
      };
    }
  }
  const transcriptPath = await claudeTranscriptPath(sessionId);
  if (!transcriptPath) return null;
  const scan = await scanSessionTasks(sessionId, transcriptPath, new Set([taskId]));
  const identity = scan.starts.get(taskId);
  if (!identity || !isInsideTaskRoot(identity.capturePath)) return null;
  return { path: identity.capturePath, capturePath: identity.capturePath, running: false };
}

function createTaskOutputRoute(): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    const match = TASK_OUTPUT_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const source = match[1]!;
    const sessionId = match[2]!;
    const taskId = match[3]!;

    return startServerSentEventStream(request, server, (write) => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const send = (message: TaskOutputMessage): void => write(encodeServerSentEvent(message));

      const run = async (): Promise<void> => {
        if (source !== "claude") {
          send({ kind: "unavailable", reason: "background output is only read for Claude sessions" });
          return;
        }
        const target = await resolveOutputTarget(sessionId, taskId);
        if (stopped) return;
        if (!target) {
          send({ kind: "unavailable", reason: "no readable output for this task" });
          return;
        }
        const label = basename(target.path);
        let file = Bun.file(target.path);
        let size = file.size;
        const from = snapshotOffset(size, SNAPSHOT_WINDOW_BYTES);
        let text = "";
        try {
          text = await file.slice(from, size).text();
        } catch {
          send({ kind: "unavailable", reason: "output file could not be read" });
          return;
        }
        if (stopped) return;
        const progress = new OutputProgress(size, Date.now());
        send({
          kind: "snapshot",
          label,
          text: lastLines(trimPartialFirstLine(text, from === 0), SNAPSHOT_LINES),
          offset: size,
          progress: { bytes: size, bytesPerSecond: 0, idleMs: 0 },
        });

        let offset = size;
        const tick = async (): Promise<void> => {
          if (stopped) return;
          file = Bun.file(target.path);
          const current = file.size;
          if (current > offset) {
            const appended = await file.slice(offset, current).text();
            if (stopped) return;
            offset = current;
            send({ kind: "append", text: appended, offset, progress: progress.observe(current, Date.now()) });
          } else {
            // Still emit progress on a quiet tick: "idle 40s" is the signal the viewer is here
            // for, and suppressing it would make a wedged task look identical to a finished one.
            send({ kind: "append", text: "", offset, progress: progress.observe(current, Date.now()) });
          }
          if (target.running) {
            // The marker is written to the harness's capture, which for a redirected task is a
            // different file from the one being streamed. Reading it from the stream target would
            // mean a redirected task never reports that it ended.
            const marker = await readTerminalMarker(target.capturePath);
            if (marker && !stopped) {
              send({ kind: "ended", state: marker });
              return;
            }
          }
          if (!stopped) timer = setTimeout(() => void tick(), config.backgroundTaskPollMs);
        };
        timer = setTimeout(() => void tick(), config.backgroundTaskPollMs);
      };

      void run().catch((error) => {
        console.error("agent feed task output stream failed", error);
        if (!stopped) send({ kind: "unavailable", reason: "output stream failed" });
      });

      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      };
    });
  };
}

export function createTaskRoutes(): RouteHandler {
  const outputRoute = createTaskOutputRoute();
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    // Checked first: the output path is a strict extension of the list path's prefix, and the
    // list regex would not match it, but keeping the more specific route ahead makes that
    // independent of how either pattern is later edited.
    const output = outputRoute(request, url, server);
    if (output !== undefined) return output;
    const match = TASKS_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const source = match[1]!;
    const sessionId = match[2]!;

    return startServerSentEventStream(request, server, (write) => {
      // Only Claude sessions run background tasks, and only they have a registry record naming the
      // process that would. A Codex row is answered once and then costs nothing at all -- it used
      // to hold a 2-second timer for the life of the stream to keep saying the same empty thing.
      if (source !== "claude") {
        write(encodeServerSentEvent(EMPTY));
        return () => {};
      }
      // The poll lives in the coordinator, not here. Every watched session shares one process
      // table, one registry pass and one `lsof` per tick, so a wall of open sessions costs about
      // what one costs; suppression of unchanged snapshots moved there with it, because only
      // something that sees every subscriber can hand a late joiner the current one.
      return backgroundTasks.subscribe(sessionId, (snapshot) => {
        write(encodeServerSentEvent(snapshot));
      });
    });
  };
}

export const handleTaskRoutes = createTaskRoutes();
