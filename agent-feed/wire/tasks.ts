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

/**
 * What a task's process tree is executing right now.
 *
 * The answer to "is it stuck", for the case where no bytes are available to answer it. A command
 * written as `node build.ts 2>&1 | tail -16` puts its output in a kernel pipe and in `tail`'s
 * memory, and there is no third copy: the stdout capture stays at zero bytes until the pipeline
 * ends, so the panel has nothing to show and neither does the harness's own. What remains
 * observable is the process tree, and it answers more than it looks like it does -- the command
 * changes as a script moves between steps, and the CPU figure separates "computing" from "blocked
 * on something that is never coming".
 *
 * Null when the task has no descendants, which is normal for a command that has just started and
 * final for one whose work is done in the shell itself.
 */
export interface TaskActivity {
  pid: number;
  /** The descendant burning the most CPU, which is the step actually doing the work. */
  command: string;
  /** CPU consumed by that process, in ms. Moves while it computes; flat while it waits. */
  cpuMs: number;
  /** How long this particular process has been alive, which is not the task's own age. */
  elapsedMs: number;
}

/**
 * What a subagent run is, beyond being a task.
 *
 * Present only on `kind: "agent"` rows. Two facts a reader wants that no other task has: which
 * agent definition was used, and which model actually answered -- `resolvedModel` is what ran,
 * where `model` is only what the caller asked for, and the two differ often enough that showing
 * the request as though it were the outcome would be a lie.
 *
 * There is no output path here on purpose. A subagent's readable trace is its own transcript,
 * which is a stream of events rather than a file of bytes, and it is served on its own route
 * keyed by this same id. See the note on `hasOutput`.
 */
export interface AgentRunDetail {
  /** The agent definition asked for: "fork", "Explore", "general-purpose", a plugin's name. */
  subagentType: string | null;
  /** The model the caller asked for, which is often absent. */
  model: string | null;
  /** The model that actually ran. */
  resolvedModel: string | null;
  /**
   * Whether the run was launched to the background.
   *
   * False means a synchronous subagent, which is never observed running -- its result exists only
   * once it is over -- but whose transcript is on disk and readable all the same. A viewer must
   * not render that as "finished in zero seconds".
   */
  launchedAsync: boolean;
}

export interface BackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  /** Present exactly when `kind` is `"agent"`. */
  agent?: AgentRunDetail;
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
   * Whether the transcript confirms the agent declared this backgrounded.
   *
   * False means the kernel found a live shell the transcript says nothing about. That is what a
   * command promoted to the background AFTER it started looks like -- the harness records the
   * promotion nowhere on disk, and the task id only reaches the transcript once the command ends,
   * so the whole time it runs there is nothing to corroborate it with. It is also what an ordinary
   * foreground command looks like, because the two are indistinguishable to the kernel: same
   * capture file, same fd, same process group. Only elapsed time separates them, and only
   * statistically.
   *
   * So the flag is not decoration. `description` on an uncorroborated row is the shell's own
   * command line, not the agent's words for it, and a viewer that presents the two identically is
   * claiming knowledge it does not have.
   */
  corroborated: boolean;
  /**
   * What the task's tree is executing, when anything is.
   *
   * Carried on every running task rather than only on the ones with no readable output, because
   * "which step is this on" is worth reading beside a log as well as instead of one.
   */
  activity: TaskActivity | null;
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
