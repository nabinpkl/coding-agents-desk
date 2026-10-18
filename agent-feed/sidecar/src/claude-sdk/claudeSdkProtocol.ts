// The line protocol between the sidecar and an SDK session's runner (ADR-0143).
//
// One JSON object per line over a unix socket, in both directions. The runner is the server and
// outlives any number of sidecars: a sidecar that restarts reconnects and is handed the whole state
// again, so nothing it held is load-bearing. Each side announces `PROTOCOL_VERSION` first, because a
// runner started yesterday keeps yesterday's code until its session restarts, and a sidecar that
// misread it would be worse than one that refused it.
//
// Every message is validated on the way in rather than cast. The socket is a file any process
// running as this user could connect to, and a shape that was assumed is a shape that drifts.

import { join } from "node:path";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  type ClaudeEffortLevel,
  type ClaudePermissionMode,
  type ClaudeSdkSessionState,
  type TmuxQuestionAnswer,
  type TmuxQuestionRefusal,
} from "@agentdesk/agent-feed-wire";

export const PROTOCOL_VERSION = 1;

/** The runner's entry file, which every runner pane's start command names. */
export const RUNNER_ENTRY_FILE = "claudeSdkRunnerMain.ts";

/**
 * Whether a pane's start command is a runner's.
 *
 * Here rather than beside the launch because the terminal's own pane rules ask it, and they sit
 * underneath the launch: a runner's command names the session id and contains "claude", which is
 * exactly what those rules take for a terminal session's pane.
 */
export function isClaudeSdkRunnerCommand(command: string): boolean {
  return command.includes(RUNNER_ENTRY_FILE);
}

/** Everything in `ClaudeSdkSessionState` the runner itself knows; `connected` is the client's. */
export type RunnerState = Omit<ClaudeSdkSessionState, "connected">;

export type SidecarToRunner =
  | { type: "hello"; version: number }
  | { type: "prompt"; id: string; text: string; images?: PromptImage[] }
  | { type: "answer"; id: string; answers: TmuxQuestionAnswer[] }
  | { type: "decide"; id: string; toolUseId: string; allow: boolean; message?: string }
  | { type: "set-mode"; id: string; mode: ClaudePermissionMode }
  | { type: "set-model"; id: string; model: string }
  | { type: "set-effort"; id: string; effort: ClaudeEffortLevel }
  | { type: "interrupt"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "stop"; id: string };

/** One image riding a prompt, as the Messages API takes it. */
export interface PromptImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64, no data-URL prefix. */
  data: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The image types the Messages API takes, which is all a prompt may carry. */
export function isPromptImageType(mime: string): mime is PromptImage["mediaType"] {
  return IMAGE_TYPES.has(mime);
}
/** As many as the panel's own send takes (`parseMessageAttachments`). */
const MAXIMUM_PROMPT_IMAGES = 5;

/** Why a command did not happen. An answer's refusals are the terminal dialog's own words. */
export type RunnerRefusal = "not-pending" | "invalid" | "failed" | TmuxQuestionRefusal;

export type RunnerReply = { ok: true } | { ok: false; reason: RunnerRefusal; message: string };

/**
 * One Anthropic stream event of the session's message, as the SDK hands it over: the same events
 * the proxy capture decodes, so the live mirror applies either. `parentToolUseId` is a subagent's,
 * which the mirror leaves to the subagent's own transcript, as it does for the capture.
 */
export interface RunnerStreamFrame {
  type: "stream";
  event: Record<string, unknown> & { type: string };
  parentToolUseId: string | null;
}

export type RunnerToSidecar =
  | { type: "hello"; version: number; sessionId: string; pid: number }
  | { type: "state"; state: RunnerState }
  | RunnerStreamFrame
  | { type: "reply"; id: string; reply: RunnerReply };

/**
 * The longest line either side buffers before giving up on the connection: a prompt carrying the
 * five 8 MiB images the panel allows, base64'd, with room to spare.
 */
export const MAXIMUM_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Where the runner for one session listens.
 *
 * One file per session id, so the sidecar can find any runner from the id alone and two runners
 * for one session collide on the path rather than both serving it.
 */
export function runnerSocketPath(directory: string, sessionId: string): string {
  const path = join(directory, `${sessionId}.sock`);
  // `sun_path` is 104 bytes on macOS and 108 on Linux, NUL included; past it the bind fails with
  // nothing in the message to say why.
  if (Buffer.byteLength(path) > 100) throw new Error(`runner socket path is too long: ${path}`);
  return path;
}

export function encodeLine(message: SidecarToRunner | RunnerToSidecar): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a byte stream into lines, holding at most one partial line. */
export class LineReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** The complete lines in `chunk`; throws when a line outgrows `MAXIMUM_LINE_BYTES`. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAXIMUM_LINE_BYTES) throw new Error("runner protocol line is too long");
    return lines.filter((line) => line.trim().length > 0);
  }
}

type Fields = Record<string, unknown>;

function object(line: string): Fields | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isId = (value: unknown): value is string => isString(value) && value.length > 0 && value.length <= 128;

function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value);
}

function isEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return (CLAUDE_EFFORT_LEVELS as readonly unknown[]).includes(value);
}

function questionAnswers(value: unknown): TmuxQuestionAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const answers: TmuxQuestionAnswer[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { question, chosen, other } = entry as Fields;
    if (!isString(question) || !isString(other) || !Array.isArray(chosen)) return null;
    const picks: TmuxQuestionAnswer["chosen"] = [];
    for (const pick of chosen) {
      if (pick === null || typeof pick !== "object") return null;
      const { index, label } = pick as Fields;
      if (!Number.isInteger(index) || (index as number) < 0 || !isString(label)) return null;
      picks.push({ index: index as number, label });
    }
    answers.push({ question, chosen: picks, other });
  }
  return answers;
}

function promptImages(value: unknown): PromptImage[] | null {
  if (!Array.isArray(value) || value.length > MAXIMUM_PROMPT_IMAGES) return null;
  const images: PromptImage[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { mediaType, data } = entry as Fields;
    if (!IMAGE_TYPES.has(mediaType as string) || !isString(data) || data.length === 0) return null;
    images.push({ mediaType: mediaType as PromptImage["mediaType"], data });
  }
  return images;
}

/** A message from the sidecar, or null for anything that is not one. */
export function parseSidecarMessage(line: string): SidecarToRunner | null {
  const fields = object(line);
  if (!fields) return null;
  switch (fields.type) {
    case "hello":
      return Number.isInteger(fields.version) ? { type: "hello", version: fields.version as number } : null;
    case "prompt": {
      if (!isId(fields.id) || !isString(fields.text) || fields.text.trim().length === 0) return null;
      if (fields.images === undefined) return { type: "prompt", id: fields.id, text: fields.text };
      const images = promptImages(fields.images);
      return images ? { type: "prompt", id: fields.id, text: fields.text, images } : null;
    }
    case "answer": {
      const answers = questionAnswers(fields.answers);
      return isId(fields.id) && answers ? { type: "answer", id: fields.id, answers } : null;
    }
    case "decide":
      if (!isId(fields.id) || !isId(fields.toolUseId) || typeof fields.allow !== "boolean") return null;
      if (fields.message !== undefined && !isString(fields.message)) return null;
      return {
        type: "decide",
        id: fields.id,
        toolUseId: fields.toolUseId,
        allow: fields.allow,
        ...(isString(fields.message) ? { message: fields.message } : {}),
      };
    case "set-mode":
      return isId(fields.id) && isPermissionMode(fields.mode) ? { type: "set-mode", id: fields.id, mode: fields.mode } : null;
    case "set-model":
      return isId(fields.id) && isString(fields.model) && /^[A-Za-z0-9._:\[\]-]{1,128}$/.test(fields.model)
        ? { type: "set-model", id: fields.id, model: fields.model }
        : null;
    case "set-effort":
      return isId(fields.id) && isEffortLevel(fields.effort) ? { type: "set-effort", id: fields.id, effort: fields.effort } : null;
    case "interrupt":
      return isId(fields.id) ? { type: "interrupt", id: fields.id } : null;
    case "rename":
      return isId(fields.id) && isString(fields.title) && fields.title.trim().length > 0 && !/[\r\n]/.test(fields.title)
        ? { type: "rename", id: fields.id, title: fields.title }
        : null;
    case "stop":
      return isId(fields.id) ? { type: "stop", id: fields.id } : null;
    default:
      return null;
  }
}

const RUN_STATUSES = new Set(["starting", "idle", "running", "requires-action", "exited"]);

/**
 * The runner's state, checked field by field.
 *
 * The pending requests are checked for the fields the panel keys on and passed through otherwise:
 * their descriptive text is the CLI's own wording and has no shape of ours to hold it to.
 */
function runnerState(value: unknown): RunnerState | null {
  if (value === null || typeof value !== "object") return null;
  const state = value as Fields;
  if (!RUN_STATUSES.has(state.status as string)) return null;
  if (state.permissionMode !== null && !isPermissionMode(state.permissionMode)) return null;
  if (typeof state.allowBypass !== "boolean") return null;
  if (!Array.isArray(state.pending) || !Number.isInteger(state.backgroundTasks)) return null;
  if (state.claudeCodeVersion !== null && !isString(state.claudeCodeVersion)) return null;
  if (state.model !== null && !isString(state.model)) return null;
  if (!Array.isArray(state.models)) return null;
  // Absent from a runner started before effort was a field: a runner outlives the sidecar's reloads.
  if (state.effort !== undefined && state.effort !== null && !isEffortLevel(state.effort)) return null;
  for (const request of state.pending) {
    if (request === null || typeof request !== "object") return null;
    const { kind, toolUseId } = request as Fields;
    if ((kind !== "question" && kind !== "approval") || !isId(toolUseId)) return null;
  }
  return { ...(state as unknown as RunnerState), effort: (state.effort as ClaudeEffortLevel | undefined) ?? null };
}

function runnerReply(value: unknown): RunnerReply | null {
  if (value === null || typeof value !== "object") return null;
  const reply = value as Fields;
  if (reply.ok === true) return { ok: true };
  if (reply.ok === false && isString(reply.reason) && isString(reply.message)) {
    return { ok: false, reason: reply.reason as RunnerRefusal, message: reply.message };
  }
  return null;
}

/** A message from a runner, or null for anything that is not one. */
export function parseRunnerMessage(line: string): RunnerToSidecar | null {
  const fields = object(line);
  if (!fields) return null;
  switch (fields.type) {
    case "hello":
      return Number.isInteger(fields.version) && isId(fields.sessionId) && Number.isInteger(fields.pid)
        ? { type: "hello", version: fields.version as number, sessionId: fields.sessionId, pid: fields.pid as number }
        : null;
    case "state": {
      const state = runnerState(fields.state);
      return state ? { type: "state", state } : null;
    }
    case "reply": {
      const reply = runnerReply(fields.reply);
      return isId(fields.id) && reply ? { type: "reply", id: fields.id, reply } : null;
    }
    case "stream": {
      const event = fields.event;
      const parent = fields.parentToolUseId;
      if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
      if (!isString((event as Fields).type) || (parent !== null && !isId(parent))) return null;
      return { type: "stream", event: event as RunnerStreamFrame["event"], parentToolUseId: parent as string | null };
    }
    default:
      return null;
  }
}

/**
 * The CLI calls one mode `manual` and the SDK calls it `default`; everything else is spelled alike.
 * The panel speaks the CLI's names, so the runner translates at the SDK's edge and nowhere else.
 */
export function sdkPermissionMode(mode: ClaudePermissionMode): "default" | Exclude<ClaudePermissionMode, "manual"> {
  return mode === "manual" ? "default" : mode;
}

export function cliPermissionMode(mode: string): ClaudePermissionMode | null {
  if (mode === "default") return "manual";
  return isPermissionMode(mode) ? mode : null;
}
