// One SDK session as the sidecar reads it: its runner's records folded into the state the panel
// shows, and the panel's commands turned into what the runner takes (ADR-0144).
//
// Everything here used to live in the runner, which meant every change to how a session is read
// waited for that session to restart. The runner now forwards what `claude` says and holds what
// must stay with `claude`; this reads it, and reloads with the sidecar on a save. Rebuilt from the
// runner's replay on every connect, so nothing in it outlives a restart that it would need to.

import type {
  ClaudeEffortLevel,
  ClaudePermissionMode,
  ClaudeSdkModel,
  ClaudeSdkPendingRequest,
  ClaudeSdkQueuedPrompt,
  ClaudeSdkRunStatus,
  TmuxQuestionAnswer,
  TmuxQuestionRefusal,
} from "@agentdesk/agent-feed-wire";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_PERMISSION_MODES } from "@agentdesk/agent-feed-wire";
import { askedQuestions, sdkAnswers, type AnswersFit } from "@/claude-sdk/claudeSdkAnswers";
import {
  isId,
  isModelName,
  type PromptImageType,
  type RunnerChoices,
  type RunnerCallback,
  type RunnerRecord,
  type RunnerState,
  type RunnerStreamFrame,
  type SidecarToRunner,
} from "@/claude-sdk/claudeSdkProtocol";

/** One image riding a prompt, as the Messages API takes it. */
export interface PromptImage {
  mediaType: PromptImageType;
  /** Base64, no data-URL prefix. */
  data: string;
}

/** What the panel asks of an SDK session, before it is turned into what the runner takes. */
export type SessionCommand =
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "answer"; answers: TmuxQuestionAnswer[] }
  | { type: "decide"; toolUseId: string; allow: boolean; message?: string }
  | { type: "set-mode"; mode: ClaudePermissionMode }
  | { type: "set-model"; model: string }
  | { type: "set-effort"; effort: ClaudeEffortLevel }
  | { type: "interrupt" }
  | { type: "rename"; title: string }
  | { type: "stop" };

/** Why a command did not happen. An answer's refusals are the terminal dialog's own words. */
export type SessionRefusal = "not-pending" | "invalid" | "failed" | TmuxQuestionRefusal;

export type SessionReply = { ok: true } | { ok: false; reason: SessionRefusal; message: string };

/** What the runner is to be sent for a command, or why it is refused without asking. */
export type CommandPlan = { send: DistributiveOmit<Exclude<SidecarToRunner, { type: "hello" }>, "id"> } | { refuse: SessionReply };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * The CLI calls one mode `manual` and the SDK calls it `default`; everything else is spelled alike.
 * The panel speaks the CLI's names, so they are translated at the SDK's edge and nowhere else.
 */
export function sdkPermissionMode(mode: ClaudePermissionMode): "default" | Exclude<ClaudePermissionMode, "manual"> {
  return mode === "manual" ? "default" : mode;
}

export function cliPermissionMode(mode: unknown): ClaudePermissionMode | null {
  if (mode === "default") return "manual";
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(mode) ? mode as ClaudePermissionMode : null;
}

const isString = (value: unknown): value is string => typeof value === "string";
type Fields = Record<string, unknown>;

const isEffortLevel = (value: unknown): value is ClaudeEffortLevel => (CLAUDE_EFFORT_LEVELS as readonly unknown[]).includes(value);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** As many as the panel's own send takes (`parseMessageAttachments`). */
const MAXIMUM_PROMPT_IMAGES = 5;

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
    images.push({ mediaType: mediaType as PromptImageType, data });
  }
  return images;
}

/** A command a request describes, checked field by field, or null for one that is not a command. */
export function parseSessionCommand(fields: Fields): SessionCommand | null {
  switch (fields.type) {
    case "prompt": {
      if (!isString(fields.text) || fields.text.trim().length === 0) return null;
      if (fields.images === undefined) return { type: "prompt", text: fields.text };
      const images = promptImages(fields.images);
      return images ? { type: "prompt", text: fields.text, images } : null;
    }
    case "answer": {
      const answers = questionAnswers(fields.answers);
      return answers ? { type: "answer", answers } : null;
    }
    case "decide":
      if (!isId(fields.toolUseId) || typeof fields.allow !== "boolean") return null;
      if (fields.message !== undefined && !isString(fields.message)) return null;
      return {
        type: "decide",
        toolUseId: fields.toolUseId,
        allow: fields.allow,
        ...(isString(fields.message) ? { message: fields.message } : {}),
      };
    case "set-mode": {
      const mode = fields.mode;
      return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(mode) ? { type: "set-mode", mode: mode as ClaudePermissionMode } : null;
    }
    case "set-model":
      return isModelName(fields.model) ? { type: "set-model", model: fields.model } : null;
    case "set-effort":
      return isEffortLevel(fields.effort) ? { type: "set-effort", effort: fields.effort } : null;
    case "interrupt":
      return { type: "interrupt" };
    case "rename":
      return isString(fields.title) && fields.title.trim().length > 0 && !/[\r\n]/.test(fields.title)
        ? { type: "rename", title: fields.title }
        : null;
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

const DENIED_IN_PANEL = "The person denied this from the agent panel.";

const SESSION_STATES: Record<string, ClaudeSdkRunStatus> = {
  idle: "idle",
  running: "running",
  requires_action: "requires-action",
};

/** The panel's own words for a turn, as the SDK takes them: images first, then the words. */
function userMessage(text: string, images: readonly PromptImage[] = []): Fields & { type: "user" } {
  const content = images.length === 0
    ? text
    : [
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text },
    ];
  // `human` because the panel's composer is somebody at a keyboard; an unstamped message is
  // treated as unattributed and fails the CLI's isHuman() gates closed (the SDK's own note).
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } };
}

/** The models list as `supportedModels()` answers it, kept to what the panel offers. */
export function sdkModels(value: unknown): ClaudeSdkModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: Fields) => {
    if (!entry || !isString(entry.value) || !isString(entry.displayName)) return [];
    const levels = Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter(isEffortLevel) : [];
    return [{
      value: entry.value,
      ...(isString(entry.resolvedModel) ? { resolvedModel: entry.resolvedModel } : {}),
      displayName: entry.displayName,
      description: isString(entry.description) ? entry.description : "",
      ...(entry.supportsEffort === true && levels.length > 0 ? { effortLevels: levels } : {}),
    }];
  });
}

export class SdkSession {
  private status: ClaudeSdkRunStatus = "starting";
  private permissionMode: ClaudePermissionMode | null = null;
  private claudeCodeVersion: string | null = null;
  private model: string | null = null;
  private models: ClaudeSdkModel[] = [];
  private effort: ClaudeEffortLevel | null = null;
  /** What `getSettings()` says the CLI would send its next request with; below anything said since. */
  private applied: { model?: string; effort?: ClaudeEffortLevel } = {};
  private backgroundTasks = 0;
  /** Prompts sent while a turn ran, held until that turn ends (`queue`). */
  private queued: ClaudeSdkQueuedPrompt[] = [];
  private nextQueued = 0;
  /** The callbacks the runner holds, by its id for each, as the panel shows them. */
  private readonly pending = new Map<string, ClaudeSdkPendingRequest>();

  /** What the session has chosen, as distinct from what the CLI reports it runs with. */
  private chosenModel: string | undefined;
  private chosenEffort: ClaudeEffortLevel | undefined;

  constructor(
    readonly sessionId: string,
    private readonly allowBypass: boolean,
    /** What its runner was launched with: a choice carried over from the runner before it. */
    launched: RunnerChoices = {},
    /**
     * The mode the runner launched in, in the SDK's spelling: shown until the CLI's own init or
     * status names one, the way t3code shows the mode it opened a query in.
     */
    launchMode: unknown = null,
  ) {
    this.chosenModel = launched.model;
    this.chosenEffort = launched.effort;
    this.model = launched.model ?? null;
    this.effort = launched.effort ?? null;
    this.permissionMode = cliPermissionMode(launchMode);
  }

  /** The model and effort to launch the next runner with: the session's own choices, never a default. */
  choices(): RunnerChoices {
    return {
      ...(this.chosenModel ? { model: this.chosenModel } : {}),
      ...(this.chosenEffort ? { effort: this.chosenEffort } : {}),
    };
  }

  state(): RunnerState {
    return {
      // A turn holding a request open is waiting on the reader, whatever else it is doing.
      status: this.pending.size > 0 && this.status === "running" ? "requires-action" : this.status,
      permissionMode: this.permissionMode,
      allowBypass: this.allowBypass,
      pending: [...this.pending.values()],
      backgroundTasks: this.backgroundTasks,
      claudeCodeVersion: this.claudeCodeVersion,
      // Before init names them, and with nothing chosen, the CLI's own word on what it would send.
      model: this.model ?? this.applied.model ?? null,
      models: this.models,
      queued: this.queued,
      effort: this.effort ?? this.applied.effort ?? null,
    };
  }

  /**
   * The model and effort the CLI would send its next request with, from `getSettings()`. Only
   * `applied` is read: the rest of that reply is the merged settings files, which this has no use
   * for and keeps nothing of.
   */
  setApplied(value: unknown): void {
    const applied = (value as Fields | null)?.applied as Fields | undefined;
    this.applied = {
      ...(isModelName(applied?.model) ? { model: applied.model } : {}),
      ...(isEffortLevel(applied?.effort) ? { effort: applied.effort } : {}),
    };
  }

  setModels(models: ClaudeSdkModel[]): void {
    this.models = models;
  }

  /**
   * The CLI answered a call, so it is up: a runner still `starting` is idle from here. Its `init`
   * comes only with the first message, so without this a runner nothing has been sent would read
   * `starting` for as long as it ran.
   */
  answered(): void {
    if (this.status === "starting") this.status = "idle";
  }

  /**
   * One record into the state, and the stream frame it carries for the live mirror, if any.
   *
   * The status is worked out here rather than read only from the CLI's `session_state_changed`,
   * which the SDK documents and the CLI did not send in any run measured on 2026-10-17 (2.1.302):
   * a turn is running from its input or first streamed byte to its result.
   */
  fold(record: RunnerRecord): RunnerStreamFrame | null {
    switch (record.kind) {
      case "input":
        this.becomes("running");
        return null;
      case "ended":
        this.status = "exited";
        this.queued = [];
        return null;
      case "called":
        this.called(record.method, record.args);
        return null;
      case "message":
        return this.message(record.message);
      default:
        return null;
    }
  }

  /**
   * A callback the runner holds, as the panel shows it. Answers with a result to settle it straight
   * away when the panel cannot show it: an AskUserQuestion without questions it can draw.
   */
  hold(callback: RunnerCallback): Fields | null {
    const { toolName, input, options } = callback;
    const toolUseId = options.toolUseID;
    if (toolName === "AskUserQuestion") {
      const questions = askedQuestions(input);
      if (!questions) return { behavior: "deny", message: "AskUserQuestion arrived without questions the panel can show." };
      this.pending.set(callback.id, { kind: "question", toolUseId, questions, openedAt: callback.openedAt });
      return null;
    }
    const text = (key: string) => (isString(options[key]) && options[key] ? { [key]: options[key] } : {});
    this.pending.set(callback.id, {
      kind: "approval",
      toolUseId,
      toolName,
      input,
      openedAt: callback.openedAt,
      ...text("title"),
      ...text("displayName"),
      ...text("description"),
      ...text("decisionReason"),
      ...text("blockedPath"),
      ...(options.defaultToNo === true ? { defaultToNo: true } : {}),
    });
    return null;
  }

  /** Whether a prompt sent now would wait behind a turn already running. */
  busy(): boolean {
    return this.status === "running" || this.status === "requires-action" || this.pending.size > 0;
  }

  /**
   * A prompt the runner took while a turn was running. The CLI either folds it into that turn or
   * starts the next with it, and says nothing either way, so it is held until the turn's result:
   * by then it has been taken in, whichever it was.
   */
  queue(text: string, images: number, sentAt: number): void {
    this.queued = [...this.queued, { id: `q${++this.nextQueued}`, text, images, sentAt }];
  }

  settled(callback: string): void {
    this.pending.delete(callback);
  }

  /** What the runner is sent for a command, decided against what is waiting now. */
  plan(command: SessionCommand): CommandPlan {
    switch (command.type) {
      case "prompt":
        if (this.status === "exited") return { refuse: { ok: false, reason: "failed", message: "the session has ended" } };
        return { send: { type: "input", message: userMessage(command.text, command.images) } };
      case "answer":
        return this.answer(command.answers);
      case "decide": {
        const entry = [...this.pending.entries()].find(([, request]) => request.kind === "approval" && request.toolUseId === command.toolUseId);
        if (!entry || entry[1].kind !== "approval") {
          return { refuse: { ok: false, reason: "not-pending", message: "that approval is no longer waiting" } };
        }
        const result = command.allow
          ? { behavior: "allow" as const, updatedInput: entry[1].input }
          : { behavior: "deny" as const, message: command.message?.trim() || DENIED_IN_PANEL };
        return { send: { type: "settle", callback: entry[0], result } };
      }
      case "set-mode":
        if (command.mode === "bypassPermissions" && !this.allowBypass) {
          return { refuse: { ok: false, reason: "invalid", message: "bypass permissions is not allowed for this session" } };
        }
        return { send: { type: "call", method: "setPermissionMode", args: [sdkPermissionMode(command.mode)] } };
      case "set-model":
        return { send: { type: "call", method: "setModel", args: [command.model] } };
      case "set-effort":
        // Through the flag settings layer, the way `/effort` does: for the session, in no settings file.
        return { send: { type: "call", method: "applyFlagSettings", args: [{ effortLevel: command.effort }] } };
      case "interrupt":
        return { send: { type: "call", method: "interrupt", args: [] } };
      case "rename":
        // The CLI's `rename_session`, as a user rename: registry name, title and agent name together
        // (measured 2026-10-17), through a control request so it does not wait behind a turn.
        return { send: { type: "call", method: "renameSession", args: [command.title, this.sessionId] } };
      case "stop":
        return { send: { type: "stop" } };
      default: {
        const unhandled: never = command;
        throw new Error(`unhandled session command ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private answer(answers: readonly TmuxQuestionAnswer[]): CommandPlan {
    const questions = [...this.pending.entries()].filter(([, request]) => request.kind === "question");
    if (questions.length === 0) return { refuse: { ok: false, reason: "no-dialog", message: "no question is waiting" } };
    let refusal: Extract<AnswersFit, { ok: false }> | null = null;
    for (const [callback, request] of questions) {
      if (request.kind !== "question") continue;
      const fit = sdkAnswers(request.questions, answers);
      if (!fit.ok) {
        // A wrong option on the right call says more than a wrong call does, so it is kept.
        if (!refusal || fit.refused === "wrong-option") refusal = fit;
        continue;
      }
      return { send: { type: "settle", callback, result: { behavior: "allow", updatedInput: { questions: request.questions, answers: fit.answers } } } };
    }
    return { refuse: { ok: false, reason: refusal!.refused, message: refusal!.message } };
  }

  private called(method: string, args: unknown[]): void {
    const [first] = args;
    switch (method) {
      case "setPermissionMode":
        this.permissionMode = cliPermissionMode(first) ?? this.permissionMode;
        return;
      case "setModel":
        // The CLI names the model it now answers with on the next turn's init; until then the choice
        // is the best account, resolved to its full id where the list says what an alias stands for.
        if (isString(first)) {
          this.chosenModel = first;
          this.model = this.models.find((entry) => entry.value === first)?.resolvedModel ?? first;
        }
        return;
      case "applyFlagSettings": {
        const level = (first as Fields | undefined)?.effortLevel;
        if (level === null || isEffortLevel(level)) {
          this.effort = level;
          // Cleared goes back to the model's default, which is no choice to carry.
          this.chosenEffort = level ?? undefined;
        }
        return;
      }
      default:
    }
  }

  private message(message: Fields & { type: string }): RunnerStreamFrame | null {
    if (message.type === "stream_event" || message.type === "assistant") {
      this.becomes("running");
      const event = message.event as Fields | undefined;
      return message.type === "stream_event" && event && isString(event.type)
        ? { event: event as RunnerStreamFrame["event"], parentToolUseId: isString(message.parent_tool_use_id) ? message.parent_tool_use_id : null }
        : null;
    }
    if (message.type === "result") {
      this.becomes("idle");
      this.queued = [];
      return null;
    }
    if (message.type !== "system") return null;
    switch (message.subtype) {
      case "init":
        this.permissionMode = cliPermissionMode(message.permissionMode);
        this.claudeCodeVersion = isString(message.claude_code_version) ? message.claude_code_version : null;
        this.model = isString(message.model) ? message.model : null;
        // Said only by a CLI that publishes it; otherwise the level chosen here stands.
        if (message.effort === null || isEffortLevel(message.effort)) this.effort = message.effort;
        if (this.status === "starting") this.status = "idle";
        return null;
      case "status":
        this.permissionMode = cliPermissionMode(message.permissionMode) ?? this.permissionMode;
        return null;
      case "session_state_changed":
        this.status = SESSION_STATES[message.state as string] ?? this.status;
        return null;
      case "background_tasks_changed":
        this.backgroundTasks = Array.isArray(message.tasks) ? message.tasks.length : this.backgroundTasks;
        return null;
      default:
        return null;
    }
  }

  private becomes(status: ClaudeSdkRunStatus): void {
    if (this.status === "exited") return;
    this.status = status;
  }
}
