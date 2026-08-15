// A session's background work: shells the agent started and left running while it kept talking.
//
// Separate from `AgentRunState` on purpose. That field is set from the model's own SSE stream
// (`message_start` -> running, `message_stop` -> idle) and means "tokens are being generated"; it
// goes idle the instant a turn ends, while the task that turn launched runs on for minutes. Both
// are true at once and they are different facts. A list rather than an enum because a session
// routinely has several tasks in flight. See ADR-0099.

/**
 * What kind of long-running work this is. All three arrive through the same harness
 * notification envelope and are told apart by which tags it carries.
 *
 *   bash    -- a background shell. The common case.
 *   agent   -- a subagent launched to run in the background.
 *   monitor -- a persistent watcher. Its notifications are PROGRESS TICKS, not completions,
 *              which is the one shape that will silently close a task that is still running.
 */
export type BackgroundTaskKind = "bash" | "agent" | "monitor";

/**
 * How a task ended, or that it has not.
 *
 * `unknown` is a real outcome, not a gap to paper over: it is what a task looks like once
 * `/private/tmp` reaping has removed its output file and the transcript never recorded a
 * completion, which is exactly what a killed task in an old session leaves behind.
 */
export type BackgroundTaskState =
  | { status: "running" }
  /** `exitCode` is null when the task is known to be over but no source recorded the code. */
  | { status: "exited"; exitCode: number | null }
  | { status: "killed" }
  | { status: "unknown" };

/**
 * Raw progress, reported rather than judged.
 *
 * There is deliberately no `stuck` flag. A quiet `xcodebuild` writes nothing for minutes and
 * then bursts, so any threshold is wrong more often than right. The question a viewer actually
 * has -- "is the agent blind-waiting?" -- is answered by whether any of these numbers is
 * moving, which a human reads better than a classifier.
 */
export interface BackgroundTaskProgress {
  /** Bytes the task has written to its real output target so far. */
  bytes: number;
  /** Growth rate over the last sampling interval. Zero is normal, not a fault. */
  bytesPerSecond: number;
  /** Time since that byte count last changed. */
  idleMs: number;
}

export interface BackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  /** The agent's own words for what it started, from the tool call's `description`. */
  description: string;
  /** The command, when the transcript still carries it. Null once it has aged out of reach. */
  command: string | null;
  /** When the harness acknowledged the start, from the transcript line's timestamp. */
  startedAt: number | null;
  state: BackgroundTaskState;
}

export interface RunningBackgroundTask extends BackgroundTask {
  state: { status: "running" };
  elapsedMs: number;
  /**
   * Absent until the task's output target has been resolved, which needs one process probe.
   * A running task with no progress yet is normal for the first tick, and is not an error.
   */
  progress?: BackgroundTaskProgress;
  /**
   * Whether anything is readable at all. False for a task whose stdout capture is empty
   * because the command redirected -- the case that reads as "No output yet" elsewhere, and
   * the reason the stream resolves its target from the task's own file descriptors.
   */
  hasOutput: boolean;
}

/**
 * One message on a task's output stream: a snapshot of the tail, then appends as it grows.
 *
 * `label` is the file's base name, not its path. The viewer wants to know which file is being
 * streamed -- often a log the command redirected into, not the task's own capture -- and the rest
 * of the path is machine detail that does not need to cross to a phone.
 */
export type TaskOutputMessage =
  | {
    kind: "snapshot";
    label: string;
    text: string;
    /** Byte offset the next append continues from. */
    offset: number;
    progress: BackgroundTaskProgress;
  }
  | { kind: "append"; text: string; offset: number; progress: BackgroundTaskProgress }
  /** The task ended while being watched. Carries how, so the row settles without a re-poll. */
  | { kind: "ended"; state: BackgroundTaskState }
  /** No readable output could be found. Distinct from an empty file, which streams normally. */
  | { kind: "unavailable"; reason: string };

export interface BackgroundTaskSnapshot {
  running: RunningBackgroundTask[];
  finished: BackgroundTask[];
  /**
   * Whether a live process still owns this session.
   *
   * False means every task is over whatever the transcript says, because nothing is left to
   * run them. Carried explicitly so the panel can distinguish "nothing running" from "we
   * cannot tell", instead of inferring it from an empty list.
   */
  ownerAlive: boolean;
}
