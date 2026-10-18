// The line protocol between the sidecar and an SDK session's runner (ADR-0143, ADR-0144).
//
// One JSON object per line over a unix socket, in both directions. The runner is a pipe and knows
// nothing about the panel: it forwards every message `claude` sends, runs any control method of the
// SDK's `Query` it is asked to, and holds each permission callback open until a sidecar settles it.
// Reading those messages into a session's state is the sidecar's, which reloads on every save; the
// runner is the one part that must not restart, so the less it knows the less often it changes.
//
// A runner still started from older code is told apart by its `build`, the hash of the files it
// runs and the SDK it loaded: the sidecar compares it with what is on disk now and relaunches a
// stale one with `resume` once the session is idle (`claudeSdkSwitch.ts`).
//
// Every message is validated on the way in rather than cast. The socket is a file any process
// running as this user could connect to, and a shape that was assumed is a shape that drifts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";

export const PROTOCOL_VERSION = 2;

/** The runner's entry file, which every runner pane's start command names. */
export const RUNNER_ENTRY_FILE = "claudeSdkRunnerMain.ts";

/**
 * Every source file the runner process loads of ours, beside this directory. Its build is their
 * hash, so a change to any of them is a stale runner; a test holds the list to the runner's imports.
 */
export const RUNNER_SOURCE_FILES = [
  RUNNER_ENTRY_FILE,
  "claudeSdkRunner.ts",
  "claudeSdkRunnerServer.ts",
  "claudeSdkProtocol.ts",
] as const;

/**
 * What a runner started now would be: its files' hash and the SDK's version, read from disk.
 *
 * The runner reads it once, at start; the sidecar reads it whenever a runner introduces itself, so
 * the two differ exactly when something the runner runs has changed since it started.
 */
export function runnerBuild(): string {
  const hash = createHash("sha256");
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of RUNNER_SOURCE_FILES) hash.update(file).update(readFileSync(join(here, file)));
  const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const sdk = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as { version?: unknown };
  return `${String(sdk.version)}+${hash.digest("hex").slice(0, 16)}`;
}

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

/**
 * The model and effort a runner was launched with, where the session had chosen them: what a
 * relaunch carries over, and what the runner reports so the next relaunch carries them again.
 * Absent means the CLI's own default, which is never pinned.
 */
export interface RunnerChoices {
  model?: string;
  effort?: EffortLevel;
}

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** A model a launch or a `setModel` may name: an alias or a full id, and nothing a shell would read. */
export function isModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:\[\]-]{1,128}$/.test(value);
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

/** Everything in `ClaudeSdkSessionState` the session itself says; `connected` is the client's. */
export type RunnerState = Omit<ClaudeSdkSessionState, "connected">;

/**
 * Something the runner keeps the latest of, so a sidecar that connects late can rebuild the state:
 * a message `claude` sent, a control call a sidecar made, a turn queued, the session ending.
 */
export type RunnerRecord =
  | { kind: "message"; message: Record<string, unknown> & { type: string } }
  | { kind: "called"; method: string; args: unknown[] }
  | { kind: "input" }
  | { kind: "ended" };

/** A permission callback the CLI is waiting on: the arguments of `canUseTool`, less its signal. */
export interface RunnerCallback {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** `canUseTool`'s options with only what survives JSON: the CLI's wording, the tool use id. */
  options: Record<string, unknown> & { toolUseID: string };
  openedAt: number;
}

export type SidecarToRunner =
  | { type: "hello"; version: number }
  /** A user message for the session's input, already in the SDK's shape. */
  | { type: "input"; id: string; message: Record<string, unknown> & { type: "user" } }
  /** Any control method of the SDK's `Query`, by name. */
  | { type: "call"; id: string; method: string; args: unknown[] }
  /** The answer to one held permission callback, which is the `PermissionResult` it resolves with. */
  | { type: "settle"; id: string; callback: string; result: Record<string, unknown> & { behavior: "allow" | "deny" } }
  | { type: "stop"; id: string };

export type RunnerReply = { ok: true; value: unknown } | { ok: false; message: string };

export type RunnerToSidecar =
  | {
    type: "hello";
    version: number;
    sessionId: string;
    pid: number;
    build: string;
    allowBypass: boolean;
    choices: RunnerChoices;
    /**
     * The mode the runner launched `claude` in, in the SDK's spelling. The CLI names its mode only
     * once a turn starts (`system/init`), so until then this is the only account of it.
     */
    permissionMode: string | null;
  }
  /** `replay` is true for what a connection is handed on arrival rather than as it happens. */
  | { type: "record"; record: RunnerRecord; replay: boolean }
  | { type: "callback"; callback: RunnerCallback }
  | { type: "settled"; callback: string }
  /** The end of what a connection is handed on arrival: its state is whole from here. */
  | { type: "replayed" }
  | { type: "reply"; id: string; reply: RunnerReply };

/**
 * One Anthropic stream event of the session's message, as the live mirror takes it: the same events
 * the proxy capture decodes. `parentToolUseId` is a subagent's, which the mirror leaves to the
 * subagent's own transcript, as it does for the capture.
 */
export interface RunnerStreamFrame {
  event: Record<string, unknown> & { type: string };
  parentToolUseId: string | null;
}

/** Control methods the runner refuses by name: they end or replace the session's own streams. */
const UNCALLABLE = new Set(["close", "streamInput", "next", "return", "throw", "constructor"]);

/** Whether a name may be called on the `Query`: a plain method name, and none that ends the session. */
export function isCallableMethod(method: string): boolean {
  return /^[a-z][A-Za-z]{1,63}$/.test(method) && !UNCALLABLE.has(method);
}

/** The image types the Messages API takes, which is all a prompt may carry. */
export type PromptImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isPromptImageType(mime: string): mime is PromptImageType {
  return IMAGE_TYPES.has(mime);
}

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

function object(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

function line(text: string): Fields | null {
  try {
    return object(JSON.parse(text));
  } catch {
    return null;
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
export const isId = (value: unknown): value is string => isString(value) && value.length > 0 && value.length <= 128;

/** A message from the sidecar, or null for anything that is not one. */
export function parseSidecarMessage(text: string): SidecarToRunner | null {
  const fields = line(text);
  if (!fields) return null;
  switch (fields.type) {
    case "hello":
      return Number.isInteger(fields.version) ? { type: "hello", version: fields.version as number } : null;
    case "input": {
      const message = object(fields.message);
      return isId(fields.id) && message?.type === "user"
        ? { type: "input", id: fields.id, message: message as Fields & { type: "user" } }
        : null;
    }
    case "call":
      return isId(fields.id) && isString(fields.method) && isCallableMethod(fields.method) && Array.isArray(fields.args)
        ? { type: "call", id: fields.id, method: fields.method, args: fields.args }
        : null;
    case "settle": {
      const result = object(fields.result);
      return isId(fields.id) && isId(fields.callback) && (result?.behavior === "allow" || result?.behavior === "deny")
        ? { type: "settle", id: fields.id, callback: fields.callback, result: result as Fields & { behavior: "allow" | "deny" } }
        : null;
    }
    case "stop":
      return isId(fields.id) ? { type: "stop", id: fields.id } : null;
    default:
      return null;
  }
}

function record(value: unknown): RunnerRecord | null {
  const fields = object(value);
  switch (fields?.kind) {
    case "message": {
      const message = object(fields.message);
      return message && isString(message.type) ? { kind: "message", message: message as Fields & { type: string } } : null;
    }
    case "called":
      return isString(fields.method) && Array.isArray(fields.args) ? { kind: "called", method: fields.method, args: fields.args } : null;
    case "input":
      return { kind: "input" };
    case "ended":
      return { kind: "ended" };
    default:
      return null;
  }
}

function callback(value: unknown): RunnerCallback | null {
  const fields = object(value);
  const input = object(fields?.input);
  const options = object(fields?.options);
  if (!fields || !input || !options || !isId(fields.id) || !isString(fields.toolName) || !isId(options.toolUseID)) return null;
  if (typeof fields.openedAt !== "number") return null;
  return {
    id: fields.id,
    toolName: fields.toolName,
    input,
    options: options as RunnerCallback["options"],
    openedAt: fields.openedAt,
  };
}

/**
 * The choices a hello reports, keeping only what is well formed. Absent from a runner started before
 * they were reported, which carries nothing over: a runner outlives the sidecar's reloads.
 */
function runnerChoices(value: unknown): RunnerChoices {
  const fields = object(value);
  return {
    ...(isModelName(fields?.model) ? { model: fields.model } : {}),
    ...(isEffortLevel(fields?.effort) ? { effort: fields.effort } : {}),
  };
}

/** A message from a runner, or null for anything that is not one. */
export function parseRunnerMessage(text: string): RunnerToSidecar | null {
  const fields = line(text);
  if (!fields) return null;
  switch (fields.type) {
    case "hello":
      return Number.isInteger(fields.version) && isId(fields.sessionId) && Number.isInteger(fields.pid)
          && isString(fields.build) && typeof fields.allowBypass === "boolean"
        ? {
          type: "hello",
          version: fields.version as number,
          sessionId: fields.sessionId,
          pid: fields.pid as number,
          build: fields.build,
          allowBypass: fields.allowBypass,
          choices: runnerChoices(fields.choices),
          // Absent from a runner started before it was reported, which then says nothing until init.
          permissionMode: isString(fields.permissionMode) ? fields.permissionMode : null,
        }
        : null;
    case "record": {
      const parsed = record(fields.record);
      return parsed && typeof fields.replay === "boolean" ? { type: "record", record: parsed, replay: fields.replay } : null;
    }
    case "callback": {
      const parsed = callback(fields.callback);
      return parsed ? { type: "callback", callback: parsed } : null;
    }
    case "settled":
      return isId(fields.callback) ? { type: "settled", callback: fields.callback } : null;
    case "replayed":
      return { type: "replayed" };
    case "reply": {
      const reply = object(fields.reply);
      if (!isId(fields.id) || !reply) return null;
      if (reply.ok === true) return { type: "reply", id: fields.id, reply: { ok: true, value: reply.value ?? null } };
      return reply.ok === false && isString(reply.message)
        ? { type: "reply", id: fields.id, reply: { ok: false, message: reply.message } }
        : null;
    }
    default:
      return null;
  }
}

