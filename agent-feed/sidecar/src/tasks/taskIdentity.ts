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
import { config } from "@/config/config";
import { isInsideTaskRoot } from "@/tasks/processProbe";
import {
  type AgentLaunch,
  parseAgentLaunch,
  parseBackgroundStart,
  parseMonitorStart,
  parseTaskNotification,
  type TaskNotification,
} from "@/tasks/taskState";

export interface TaskIdentity {
  taskId: string;
  description: string;
  command: string | null;
  startedAt: number | null;
  /** The harness's stdout capture, as the harness itself named it. Fenced before use. */
  capturePath: string;
}

/**
 * A Monitor watcher, which the transcript describes fully and the kernel describes not at all.
 *
 * Its `command` is load-bearing rather than decorative: a Monitor's shell holds no capture file, so
 * the command IS the join between the transcript record and the live process. Everything else here
 * is what the panel shows.
 */
export interface MonitorIdentity {
  taskId: string;
  description: string;
  command: string;
  startedAt: number | null;
  timeoutMs: number | null;
}

/**
 * A subagent the session launched, as the transcript describes it.
 *
 * Distinct from `TaskIdentity` because a subagent has no shell: the kernel knows nothing about
 * it, there is no capture file to hold open and no process tree to probe. Everything observable
 * about one is in the two transcripts -- the parent's, which says it was launched, and its own,
 * which says how far it has got. So this carries no `capturePath`, and its liveness is decided
 * by the absence of a completion rather than by a descriptor.
 *
 * `subagentType` and `model` come from the tool_use half of the pair and are null when that half
 * fell outside the read window, which is normal at a window's edge.
 */
export interface AgentIdentity {
  agentId: string;
  description: string;
  subagentType: string | null;
  model: string | null;
  resolvedModel: string | null;
  startedAt: number | null;
  launchedAsync: boolean;
}

export interface TranscriptTaskScan {
  starts: Map<string, TaskIdentity>;
  monitors: Map<string, MonitorIdentity>;
  /** Subagents launched from this session, keyed by agent id. */
  agents: Map<string, AgentIdentity>;
  /** Keyed by task id; a later record replaces an earlier one, so a completion beats a tick. */
  notifications: Map<string, TaskNotification>;
}

interface ToolUseInput {
  command?: unknown;
  description?: unknown;
  run_in_background?: unknown;
  /** Agent only: which agent definition was asked for. */
  subagent_type?: unknown;
  /** Agent only: the model override the caller asked for, which need not be the one resolved. */
  model?: unknown;
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
  const monitors = new Map<string, MonitorIdentity>();
  const agents = new Map<string, AgentIdentity>();
  const notifications = new Map<string, TaskNotification>();
  // tool_use id -> what that call asked for, held until its result names the task id.
  const pending = new Map<string, { input: ToolUseInput; at: number | null; name: string }>();

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
    // Only the conversation itself. Claude Code also writes `api-request-blob` records, copies of
    // what it sent the API that repeat earlier calls and results with no timestamp of their own;
    // read as events, a copy rewrote a task's start with no time and the panel showed it at 0s.
    if (record.type !== "user" && record.type !== "assistant") continue;

    const message = record.message as { content?: unknown } | undefined;
    const blocks = message?.content;
    // The SAME notification reaches the transcript in two shapes, and only one of them was being
    // read. A notification that arrives while the session is mid-turn is queued and lands as a
    // `queued_command` attachment; one that arrives while it is idle is delivered straight into
    // the conversation as an ordinary user message whose content is a plain string. Measured on
    // this repo's own transcript: three of each, for BASH tasks as well as subagents. Missing the
    // second shape leaves a finished task showing as running until something else retires it,
    // which for a subagent is never, because a subagent has no shell for the kernel to contradict
    // the transcript with.
    if (typeof blocks === "string") {
      const notification = parseTaskNotification(blocks);
      if (notification) notifications.set(notification.taskId, notification);
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === "tool_use") {
        const input = typed.input as ToolUseInput | undefined;
        const name = typeof typed.name === "string" ? typed.name : "";
        // A Monitor and an Agent are pended on their NAME, where a backgrounded shell is pended
        // on the flag it set: neither has `run_in_background`, both are background by nature.
        if (!input?.run_in_background && name !== "Monitor" && name !== "Agent") continue;
        if (typeof typed.id === "string") pending.set(typed.id, { input: input ?? {}, at: timestamp, name });
        continue;
      }
      if (typed.type !== "tool_result") continue;
      const callId = typeof typed.tool_use_id === "string" ? typed.tool_use_id : undefined;
      // A subagent's start is the only one carried BESIDE the message rather than inside it, so
      // it is read off the record while the block supplies the id that pairs the two.
      const launch = parseAgentLaunch(record.toolUseResult);
      if (launch) {
        recordAgent(agents, launch, callId ? pending.get(callId) : undefined, timestamp);
        continue;
      }
      const content = typed.content;
      const asText = typeof content === "string" ? content : JSON.stringify(content ?? "");
      const watcher = parseMonitorStart(asText);
      if (watcher) {
        const call = callId ? pending.get(callId) : undefined;
        const command = typeof call?.input.command === "string" ? call.input.command : null;
        // Without the command there is no way to find this watcher's process, and a Monitor row
        // that cannot be shown to be alive is worse than no row. Dropped rather than guessed at.
        if (command !== null) {
          monitors.set(watcher.taskId, {
            taskId: watcher.taskId,
            description:
              typeof call?.input.description === "string" && call.input.description.trim()
                ? call.input.description.trim()
                : command.slice(0, 200),
            command,
            startedAt: call?.at ?? timestamp,
            timeoutMs: watcher.timeoutMs,
          });
        }
        continue;
      }
      const started = parseBackgroundStart(asText);
      if (!started) continue;
      const call = callId ? pending.get(callId) : undefined;
      const input = call?.input;
      starts.set(started.taskId, {
        taskId: started.taskId,
        // The agent's `description` is written for a human and is what the panel shows. Falling
        // back to the command keeps a row legible when the tool_use half of the pair fell outside
        // the window, which is normal at a window's edge.
        description:
          typeof input?.description === "string" && input.description.trim()
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
  return { starts, monitors, agents, notifications };
}

type PendingCall = { input: ToolUseInput; at: number | null; name: string };

/**
 * Fold one launch and the call that made it into a row.
 *
 * Split out because the pairing has three fallbacks and inlining them made the parse loop
 * unreadable. The description falls back to the launch's own copy and then to the agent id,
 * because a row a reader cannot name is worse than a terse one.
 */
function recordAgent(
  agents: Map<string, AgentIdentity>,
  launch: AgentLaunch,
  call: PendingCall | undefined,
  timestamp: number | null,
): void {
  const asked = call?.input;
  const description =
    (typeof asked?.description === "string" && asked.description.trim()
      ? asked.description.trim()
      : launch.description) ?? launch.agentId;
  agents.set(launch.agentId, {
    agentId: launch.agentId,
    description,
    subagentType: typeof asked?.subagent_type === "string" ? asked.subagent_type : null,
    model: typeof asked?.model === "string" ? asked.model : null,
    resolvedModel: launch.resolvedModel,
    startedAt: call?.at ?? timestamp,
    launchedAsync: launch.launchedAsync,
  });
}

/**
 * The last `bytes` of a file, minus the partial line at the front.
 *
 * Dropping that first line matters: a window almost always begins mid-record, and half a JSON
 * object parses as nothing rather than as something wrong, but skipping it keeps the log clean.
 */
export async function readBackwardWindow(
  path: string,
  bytes: number,
): Promise<{ text: string; whole: boolean; size: number }> {
  const size = (await stat(path)).size;
  const from = Math.max(0, size - bytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const text = buffer.toString("utf8");
    if (from === 0) return { text, whole: true, size };
    const firstBreak = text.indexOf("\n");
    return { text: firstBreak === -1 ? "" : text.slice(firstBreak + 1), whole: false, size };
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
const WINDOW_BYTES = [1024 * 1024, 4 * 1024 * 1024] as const;

interface SessionScan extends TranscriptTaskScan {
  path: string;
  /** Bytes consumed so far. Everything before this has been parsed and folded in. */
  offset: number;
}

/**
 * Per-session accumulated scan.
 *
 * Process-local and unbounded only in the number of SESSIONS someone has subscribed to, which is
 * one at a time in the panel. Cleared when a session's transcript is replaced.
 */
const scans = new Map<string, SessionScan>();

/**
 * Resolve a session's background tasks from its transcript, reading each byte once.
 *
 * The first call reads a backward window, because a task worth showing was started recently and
 * the file it lives in can be 29 MB. Every call after that reads only what has been APPENDED,
 * which is a few kilobytes, because a transcript is append-only.
 *
 * That incremental step is what makes the poll affordable and also what makes it complete: a task
 * seen once stays known, so a long-running one does not fall out of the window as the session
 * talks past it. Growing the window on every tick instead would have meant re-reading megabytes
 * two seconds apart, forever, chasing ids that are foreground commands and will never resolve.
 *
 * `requiredTaskIds` only widens the FIRST read. Finished tasks are whatever that window contained,
 * a deliberate bound: a three-hour session has 181 of them and nobody wants that list.
 */
export async function scanSessionTasks(
  sessionId: string,
  transcriptPath: string,
  requiredTaskIds: ReadonlySet<string>,
): Promise<TranscriptTaskScan> {
  const cached = scans.get(sessionId);
  if (cached && cached.path === transcriptPath) {
    const size = (await stat(transcriptPath)).size;
    // A file that shrank is a different file wearing the same name -- a compaction rewrite, or a
    // session id reused across a rotation. Start over rather than parse from a stale offset.
    if (size >= cached.offset) {
      if (size > cached.offset) {
        const { text, consumed } = await readForward(transcriptPath, cached.offset, size);
        const fresh = parseTranscriptWindow(text);
        for (const [id, identity] of fresh.starts) cached.starts.set(id, identity);
        for (const [id, watcher] of fresh.monitors) cached.monitors.set(id, watcher);
        for (const [id, agent] of fresh.agents) cached.agents.set(id, agent);
        for (const [id, notification] of fresh.notifications) {
          cached.notifications.set(id, notification);
        }
        cached.offset += consumed;
      }
      return {
        starts: cached.starts,
        monitors: cached.monitors,
        agents: cached.agents,
        notifications: cached.notifications,
      };
    }
  }

  let scan: TranscriptTaskScan = {
    starts: new Map(),
    monitors: new Map(),
    agents: new Map(),
    notifications: new Map(),
  };
  let size = 0;
  for (const bytes of WINDOW_BYTES) {
    const window = await readBackwardWindow(transcriptPath, bytes);
    size = window.size;
    scan = parseTranscriptWindow(window.text);
    const missing = [...requiredTaskIds].some((id) => !scan.starts.has(id));
    if (!missing || window.whole) break;
  }
  scans.set(sessionId, { ...scan, path: transcriptPath, offset: size });
  return scan;
}

/** Testing seam: forget what has been accumulated for a session. */
export function forgetSessionScan(sessionId: string): void {
  scans.delete(sessionId);
}

/**
 * Read an appended range, stopping at the last complete line.
 *
 * A transcript can be mid-write when this runs, so the final line is often a fragment. Consuming
 * it would advance the offset past a record that was never parsed, losing it permanently; leaving
 * it unconsumed means the next tick reads it whole.
 */
async function readForward(path: string, from: number, to: number): Promise<{ text: string; consumed: number }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    await handle.read(buffer, 0, buffer.length, from);
    const text = buffer.toString("utf8");
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak === -1) return { text: "", consumed: 0 };
    return {
      text: text.slice(0, lastBreak + 1),
      consumed: Buffer.byteLength(text.slice(0, lastBreak + 1), "utf8"),
    };
  } finally {
    await handle.close();
  }
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
