// Reading a background task's fate off the two records the harness leaves behind.
//
// Pure by construction: every function here takes text and returns a value, so the rules can be
// tested against fixtures without forking `lsof` or standing up a session. The process probing
// lives in `processProbe.ts` and the reconciliation in `backgroundTasks.ts`.
//
// The reason there are two records at all is that neither is complete, and they fail in opposite
// directions (ADR-0099):
//
//   the .output marker    immediate and present even for kills, but the file lives in
//                         /private/tmp and is reaped
//   the task-notification durable in the transcript forever, but NEVER WRITTEN for a task that
//                         was killed -- measured, two of one session's four finished tasks
//
// Trusting either alone leaves a task showing "running" long after it stopped.

import type { BackgroundTaskKind, BackgroundTaskState } from "@agentdesk/agent-feed-wire";

/**
 * The harness's terminal line, appended to the task's own stdout capture.
 *
 * Anchored to the very end of the content, because a task is perfectly entitled to print the
 * literal text `[killed]` in the middle of its output -- a grep for it anywhere would let a log
 * line about someone else's process close this task.
 */
const TERMINAL_MARKER = /\[(?:exited with code (-?\d+)|(killed))\]$/;

/**
 * Read the terminal marker out of a task's output tail, or null while it is still running.
 *
 * Takes a tail rather than a path so the caller decides how much to read; the marker is the last
 * thing in the file, so a couple of hundred bytes is always enough.
 */
export function parseTerminalMarker(tail: string): BackgroundTaskState | null {
  const match = TERMINAL_MARKER.exec(tail.trimEnd());
  if (!match) return null;
  if (match[2]) return { status: "killed" };
  const code = Number(match[1]);
  if (!Number.isSafeInteger(code)) return null;
  return { status: "exited", exitCode: code };
}

/**
 * The start record, as the harness writes it into the `tool_result` for a backgrounded Bash call.
 *
 * The output path is taken from here rather than rebuilt from a project slug and session id,
 * because the harness is the authority on its own layout and a path we assemble ourselves is a
 * guess that breaks quietly when that layout moves.
 */
export interface BackgroundTaskStart {
  taskId: string;
  /** Same name as `TaskShell.capturePath` in processProbe: it is the same file. */
  capturePath: string;
}

// The path is anchored on its `.output` suffix rather than taken as "the next run of non-space",
// because the harness states it mid-sentence and a greedy match eats the full stop that follows it.
const START_RECORD = /Command running in background with ID: (\w+)\. Output is being written to: (\S+\.output)/;

export function parseBackgroundStart(toolResultText: string): BackgroundTaskStart | null {
  const match = START_RECORD.exec(toolResultText);
  if (!match) return null;
  return { taskId: match[1]!, capturePath: match[2]! };
}

/**
 * A Monitor's start record, which is a different sentence and names no file.
 *
 * It names no file because a Monitor HAS no file. Measured on two live watchers: the shell's fd 1
 * and fd 2 are a socket pair, not `tasks/<id>.output`, because the harness reads each line as it is
 * written and turns it into a notification. So the descriptor join that finds every backgrounded
 * shell finds nothing here, and a running Monitor was invisible to us while the harness's own panel
 * listed it correctly.
 *
 * The timeout is carried because a Monitor is the one task kind with a known end: it is killed at
 * that deadline whether or not it has seen anything.
 */
export interface MonitorStart {
  taskId: string;
  timeoutMs: number | null;
}

const MONITOR_RECORD = /Monitor started \(task (\w+)(?:, timeout (\d+)ms)?\)/;

export function parseMonitorStart(toolResultText: string): MonitorStart | null {
  const match = MONITOR_RECORD.exec(toolResultText);
  if (!match) return null;
  const timeout = match[2] === undefined ? null : Number(match[2]);
  return {
    taskId: match[1]!,
    timeoutMs: timeout !== null && Number.isSafeInteger(timeout) ? timeout : null,
  };
}

/**
 * A notification the harness queues back into the conversation when something long-running has
 * news. Modelled as a union so the Monitor trap is unrepresentable rather than merely documented:
 * a caller that wants completions cannot accidentally be handed a progress tick, because the two
 * do not share a shape.
 */
export type TaskNotification =
  | {
    kind: "completion";
    taskId: string;
    /** The harness's own word. `failed` still means the task is over. */
    status: "completed" | "failed";
    summary: string;
    /**
     * The exit code, when the summary names one -- it reads `... completed (exit code 0)`.
     * Null when it does not, which is not the same as zero and must not be rendered as success.
     */
    exitCode: number | null;
    /** Subagent notifications carry usage and duration; plain shells do not. */
    taskKind: BackgroundTaskKind;
  }
  | {
    kind: "progress";
    taskId: string;
    summary: string;
  };

function tagValue(source: string, tag: string): string | null {
  // Non-greedy and dot-all: a summary can and does run across lines.
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source);
  return match ? match[1]!.trim() : null;
}

/**
 * Parse one `<task-notification>` block.
 *
 * Three shapes share this envelope and the tags tell them apart:
 *
 *   status + output-file            a background shell finished
 *   status + subagent_tokens/usage  a background subagent finished
 *   event, and NO status            a Monitor watcher fired -- it is STILL RUNNING
 *
 * That last one is the whole reason this function exists rather than a `status` regex at the call
 * site. A Monitor emits many notifications over its life, and treating any of them as a
 * completion retires a watcher that is still watching.
 */
export function parseTaskNotification(prompt: string): TaskNotification | null {
  if (!prompt.includes("<task-notification>")) return null;
  const taskId = tagValue(prompt, "task-id");
  if (!taskId) return null;
  const summary = tagValue(prompt, "summary") ?? "";
  const status = tagValue(prompt, "status");
  if (!status) {
    // No status at all. Only a progress tick looks like this; anything else is a shape this
    // build has not seen, and reporting it as progress keeps a task open rather than closing
    // one on a record we did not understand.
    return { kind: "progress", taskId, summary };
  }
  if (status !== "completed" && status !== "failed") return null;
  const taskKind: BackgroundTaskKind = tagValue(prompt, "subagent_tokens") !== null ||
      tagValue(prompt, "tool_uses") !== null
    ? "agent"
    : "bash";
  const codeMatch = /exit code (-?\d+)/.exec(summary);
  const exitCode = codeMatch && Number.isSafeInteger(Number(codeMatch[1])) ? Number(codeMatch[1]) : null;
  return { kind: "completion", taskId, status, summary, exitCode, taskKind };
}

/**
 * Decide a task's state from everything known about it.
 *
 * Precedence is deliberate and is the correction the live smoke forced:
 *
 *   1. a live process holding the task's output open  -> running, whatever the transcript says
 *   2. a terminal marker in the output file           -> that outcome, whatever the transcript says
 *   3. a completion notification                      -> over, with whatever code it named
 *   4. nothing                                        -> unknown, and never "running"
 *
 * The transcript sits below both observations because it is the source that lies about kills. The
 * final case refuses to guess: a start with no evidence either way is a task whose output file has
 * been reaped, which is over in every case that matters and must not inflate a running count.
 *
 * `failed` still resolves to `exited`, because a task that failed has ended. Only the code is in
 * doubt, and it travels as null rather than being flattened to a zero that would read as success.
 */
export function resolveTaskState(
  evidence: {
    holdsOutputOpen: boolean;
    marker: BackgroundTaskState | null;
    notification: TaskNotification | null;
  },
): BackgroundTaskState {
  if (evidence.holdsOutputOpen) return { status: "running" };
  if (evidence.marker) return evidence.marker;
  const notification = evidence.notification;
  if (notification?.kind === "completion") {
    return { status: "exited", exitCode: notification.exitCode };
  }
  return { status: "unknown" };
}
