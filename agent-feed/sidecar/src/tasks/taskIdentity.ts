// What a task IS, as opposed to whether it is running.
//
// The kernel knows a task's id and its file descriptors; only the transcript knows the agent's own
// words for what it started. This module reads those words, and nothing else -- state comes from
// `taskState.ts` and `processProbe.ts`.
//
// It reads BACKWARD in growing windows rather than from the top, because a task worth showing was
// started recently and the file it lives in is large. ADR-0097's bounded-tail trick does not
// transfer: a 512 KB tail of a 29 MB transcript yields 15 lines, because individual transcript
// lines are enormous. Measured on that file, resolving a task started 25 minutes ago took a 1 MB
// window and 4 ms; one started three hours ago took 4 MB and 21 ms.

import { open, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { isInsideTaskRoot } from "./processProbe.ts";
import { parseBackgroundStart, parseTaskNotification, type TaskNotification } from "./taskState.ts";

export interface TaskIdentity {
  taskId: string;
  description: string;
  command: string | null;
  startedAt: number | null;
  /** The harness's stdout capture, as the harness itself named it. Fenced before use. */
  capturePath: string;
}

export interface TranscriptTaskScan {
  starts: Map<string, TaskIdentity>;
  /** Keyed by task id; a later record replaces an earlier one, so a completion beats a tick. */
  notifications: Map<string, TaskNotification>;
}

interface ToolUseInput {
  command?: unknown;
  description?: unknown;
  run_in_background?: unknown;
}

/**
 * Pull every background-task record out of a slab of transcript lines.
 *
 * Pure, so the parsing rules are testable without a file. Unparseable lines are skipped rather
 * than raised: a window that begins mid-line always has one, and a transcript is also allowed to
 * contain records this build has never seen.
 */
export function parseTranscriptWindow(text: string): TranscriptTaskScan {
  const starts = new Map<string, TaskIdentity>();
  const notifications = new Map<string, TaskNotification>();
  // tool_use id -> what that call asked for, held until its result names the task id.
  const pending = new Map<string, { input: ToolUseInput; at: number | null }>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const timestamp = Number.isFinite(at) ? at : null;

    if (record.type === "attachment") {
      const attachment = record.attachment as { type?: unknown; prompt?: unknown } | undefined;
      if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string") continue;
      const notification = parseTaskNotification(attachment.prompt);
      if (notification) notifications.set(notification.taskId, notification);
      continue;
    }

    const message = record.message as { content?: unknown } | undefined;
    const blocks = message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === "tool_use") {
        const input = typed.input as ToolUseInput | undefined;
        if (!input?.run_in_background) continue;
        if (typeof typed.id === "string") pending.set(typed.id, { input, at: timestamp });
        continue;
      }
      if (typed.type !== "tool_result") continue;
      const content = typed.content;
      const asText = typeof content === "string" ? content : JSON.stringify(content ?? "");
      const started = parseBackgroundStart(asText);
      if (!started) continue;
      const call = typeof typed.tool_use_id === "string" ? pending.get(typed.tool_use_id) : undefined;
      const input = call?.input;
      starts.set(started.taskId, {
        taskId: started.taskId,
        // The agent's `description` is written for a human and is what the panel shows. Falling
        // back to the command keeps a row legible when the tool_use half of the pair fell outside
        // the window, which is normal at a window's edge.
        description: typeof input?.description === "string" && input.description.trim()
          ? input.description.trim()
          : typeof input?.command === "string"
          ? input.command.trim().slice(0, 200)
          : started.taskId,
        command: typeof input?.command === "string" ? input.command : null,
        startedAt: call?.at ?? timestamp,
        capturePath: started.capturePath,
      });
    }
  }
  return { starts, notifications };
}

/**
 * The last `bytes` of a file, minus the partial line at the front.
 *
 * Dropping that first line matters: a window almost always begins mid-record, and half a JSON
 * object parses as nothing rather than as something wrong, but skipping it keeps the log clean.
 */
export async function readBackwardWindow(path: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const size = (await stat(path)).size;
  const from = Math.max(0, size - bytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const text = buffer.toString("utf8");
    if (from === 0) return { text, whole: true };
    const firstBreak = text.indexOf("\n");
    return { text: firstBreak === -1 ? "" : text.slice(firstBreak + 1), whole: false };
  } finally {
    await handle.close();
  }
}

/**
 * Window sizes, smallest first.
 *
 * A RUNNING task is by definition recent, so the first window resolves it in the ordinary case;
 * the larger ones exist for a session that has been open for hours. `Infinity` is the last resort
 * and reads the file, which is 27 ms even at 29 MB -- affordable only because this runs for
 * sessions with a live process, of which there are a handful, not the catalog's 1237.
 */
const WINDOW_BYTES = [1024 * 1024, 4 * 1024 * 1024, Infinity] as const;

/**
 * Resolve a session's background tasks from its transcript.
 *
 * Grows the window only while a REQUIRED task is still unresolved -- required meaning the kernel
 * says it is running, so a row for it is going on screen and needs a description. Finished tasks
 * are whatever the window happened to contain, which is a deliberate bound: a three-hour session
 * has 181 of them and nobody wants that list.
 */
export async function scanSessionTasks(
  transcriptPath: string,
  requiredTaskIds: ReadonlySet<string>,
): Promise<TranscriptTaskScan> {
  let scan: TranscriptTaskScan = { starts: new Map(), notifications: new Map() };
  for (const bytes of WINDOW_BYTES) {
    const { text, whole } = await readBackwardWindow(transcriptPath, bytes);
    scan = parseTranscriptWindow(text);
    const missing = [...requiredTaskIds].some((id) => !scan.starts.has(id));
    if (!missing || whole) break;
  }
  return scan;
}

/**
 * A Claude session's transcript, found by name rather than by rebuilding the project slug.
 *
 * The slug is the session's cwd with separators replaced, which is the harness's business and has
 * edge cases we would be guessing at. The file name is the session id, so a scan of the project
 * directories finds it without encoding that rule here.
 */
export async function claudeTranscriptPath(sessionId: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await readdir(config.claudeProjectsDirectory);
  } catch {
    return null;
  }
  const wanted = `${sessionId}.jsonl`;
  for (const project of projects) {
    const candidate = join(config.claudeProjectsDirectory, project, wanted);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Whether a capture path the transcript named is somewhere we are willing to read. */
export function captureIsReadable(identity: TaskIdentity): boolean {
  return isInsideTaskRoot(identity.capturePath);
}
