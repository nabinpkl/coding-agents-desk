// One Claude session held through the Agent SDK: the part of the runner that is not a socket.
//
// It owns one long-lived `query()` for the whole session, fed by a queue, so `claude` stays up
// between prompts the way a terminal session does (t3code's shape; see ADR-0143). It owns every
// tool call the session is waiting on -- an AskUserQuestion, an approval the permission mode did
// not settle -- and holds each one open until somebody answers. Nothing here times a request out:
// waiting for the reader is the whole point, and a sidecar restart in between must lose nothing.
//
// Pure of I/O beyond the injected query, so its tests drive it with a fake SDK and no CLI.

import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudePermissionMode,
  ClaudeSdkApprovalRequest,
  ClaudeSdkPendingRequest,
  ClaudeSdkQuestion,
  ClaudeSdkQuestionRequest,
  ClaudeSdkRunStatus,
  TmuxQuestionAnswer,
} from "@agentdesk/agent-feed-wire";
import {
  cliPermissionMode,
  sdkPermissionMode,
  type PromptImage,
  type RunnerReply,
  type RunnerState,
  type RunnerStreamFrame,
} from "@/claude-sdk/claudeSdkProtocol";

/** What the sidecar decided about this session before the runner started. */
export interface RunnerPlan {
  sessionId: string;
  cwd: string;
  /** The session's name: its title and its registry address, the way `-n` sets both. */
  name: string;
  start: "new" | "resume" | "fork";
  /** For a fork: the session it branches from, and the record its history is cut at, if any. */
  forkFrom?: string;
  resumeAt?: string;
  permissionMode: ClaudePermissionMode;
  allowBypass: boolean;
  pluginDirectories: string[];
  /** The installed `claude` this session runs. */
  claudePath: string;
  /** A first turn to send as soon as the query is open. */
  firstTurn?: string;
}

/** The part of the SDK's `Query` the runner uses. */
export interface RunnerQuery extends AsyncIterable<SDKMessage> {
  setPermissionMode(mode: "default" | Exclude<ClaudePermissionMode, "manual">): Promise<void>;
  interrupt(): Promise<unknown>;
  /**
   * The CLI's `rename_session` control request, as a user rename (`source: "host"`). On the SDK's
   * `Query` though not in its typed interface (0.3.302), so it is checked for at the call rather
   * than assumed: a later SDK without it is a loud refusal, not a quiet half-rename.
   */
  renameSession?(title: string, sessionId?: string): Promise<void>;
}

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => RunnerQuery;

/** A pushed-to async iterable: the session's input, which stays open until `close`. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("the session's input is closed");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.queued.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface Pending {
  request: ClaudeSdkPendingRequest;
  settle: (result: PermissionResult) => void;
}

const DENIED_IN_PANEL = "The person denied this from the agent panel.";

/** The questions of an AskUserQuestion call, or null when the input is not that shape. */
export function askedQuestions(input: Record<string, unknown>): ClaudeSdkQuestion[] | null {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: ClaudeSdkQuestion[] = [];
  for (const entry of questions) {
    if (entry === null || typeof entry !== "object") return null;
    const { question, header, multiSelect, options } = entry as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options)) return null;
    parsed.push({
      question,
      header: typeof header === "string" ? header : "",
      multiSelect: multiSelect === true,
      options: options.map((option) => {
        const { label, description } = (option ?? {}) as Record<string, unknown>;
        return { label: String(label ?? ""), description: typeof description === "string" ? description : "" };
      }),
    });
  }
  return parsed;
}

export type AnswersFit =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; refused: "wrong-dialog" | "wrong-option"; message: string };

/**
 * The SDK's answers for one call, keyed by question text, or the reason they do not fit it.
 *
 * Matched by the text of every question, in order, the rule the terminal dialog's driver answers
 * by: position picks the row and text decides whether to go through with it. A choice is checked
 * by index AND label, so an option list that changed under the reader is refused rather than
 * answered with whatever now sits at that index.
 */
export function sdkAnswers(
  questions: readonly ClaudeSdkQuestion[],
  answers: readonly TmuxQuestionAnswer[],
): AnswersFit {
  if (questions.length !== answers.length || questions.some((asked, at) => asked.question !== answers[at]!.question)) {
    return { ok: false, refused: "wrong-dialog", message: "the answers do not describe the question that is waiting" };
  }
  const result: Record<string, string> = {};
  for (const [at, asked] of questions.entries()) {
    const answer = answers[at]!;
    if (!asked.multiSelect && answer.chosen.length > 1) {
      return { ok: false, refused: "wrong-option", message: `"${asked.question}" takes one answer` };
    }
    for (const pick of answer.chosen) {
      if (asked.options[pick.index]?.label !== pick.label) {
        return { ok: false, refused: "wrong-option", message: `"${pick.label}" is not option ${pick.index + 1} of "${asked.question}"` };
      }
    }
    const said = [...answer.chosen.map((pick) => pick.label), ...(answer.other.trim() ? [answer.other.trim()] : [])];
    if (said.length === 0) return { ok: false, refused: "wrong-option", message: `"${asked.question}" has no answer` };
    result[asked.question] = said.join(", ");
  }
  return { ok: true, answers: result };
}

const SESSION_STATES: Record<string, ClaudeSdkRunStatus> = {
  idle: "idle",
  running: "running",
  requires_action: "requires-action",
};

/** Which conversation the query opens: a new one, this session's own, or a fork of another's. */
function startOptions(plan: RunnerPlan): Options {
  switch (plan.start) {
    case "new":
      return { sessionId: plan.sessionId };
    case "resume":
      return { resume: plan.sessionId };
    case "fork":
      if (!plan.forkFrom) throw new Error("a fork needs the session it forks from");
      return {
        resume: plan.forkFrom,
        forkSession: true,
        sessionId: plan.sessionId,
        ...(plan.resumeAt ? { resumeSessionAt: plan.resumeAt } : {}),
      };
    default: {
      const unhandled: never = plan.start;
      throw new Error(`unknown start ${String(unhandled)}`);
    }
  }
}

export class ClaudeSdkRunner {
  private status: ClaudeSdkRunStatus = "starting";
  private permissionMode: ClaudePermissionMode | null = null;
  private claudeCodeVersion: string | null = null;
  private backgroundTasks = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(state: RunnerState) => void>();
  private readonly streamListeners = new Set<(frame: RunnerStreamFrame) => void>();
  private readonly prompts = new PromptQueue();
  private query: RunnerQuery | null = null;

  constructor(
    private readonly plan: RunnerPlan,
    private readonly createQuery: QueryFactory,
    private readonly now: () => number = Date.now,
  ) {}

  /** The `query()` options this plan comes to. Exposed for the test that pins them. */
  options(): Options {
    const plan = this.plan;
    return {
      cwd: plan.cwd,
      ...startOptions(plan),
      pathToClaudeCodeExecutable: plan.claudePath,
      permissionMode: sdkPermissionMode(plan.permissionMode),
      ...(plan.allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
      plugins: plan.pluginDirectories.map((path) => ({ type: "local" as const, path })),
      // Without it Opus streams and stores its thinking empty, and the grey lines a terminal
      // session shows are gone from the card and the transcript alike (measured 2026-10-17).
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      // `-n`: the title and the registry name a terminal session gets, on a resume too, where the
      // SDK would otherwise derive a name from the directory (measured 2026-10-17).
      extraArgs: { name: plan.name },
      canUseTool: this.canUseTool,
    };
  }

  state(): RunnerState {
    return {
      // A turn holding a request open is waiting on the reader, whatever else it is doing.
      status: this.pending.size > 0 && this.status === "running" ? "requires-action" : this.status,
      permissionMode: this.permissionMode,
      allowBypass: this.plan.allowBypass,
      pending: [...this.pending.values()].map((entry) => entry.request),
      backgroundTasks: this.backgroundTasks,
      claudeCodeVersion: this.claudeCodeVersion,
    };
  }

  subscribe(listener: (state: RunnerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every streamed event of the session's messages, as it arrives, for the live mirror. */
  onStream(listener: (frame: RunnerStreamFrame) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  /** Runs the session until its input closes and `claude` exits. Resolves; never rejects. */
  async run(log: (line: string) => void): Promise<void> {
    const query = this.createQuery({ prompt: this.prompts, options: this.options() });
    this.query = query;
    if (this.plan.firstTurn) this.prompts.push(this.userMessage(this.plan.firstTurn));
    try {
      for await (const message of query) this.handle(message);
    } catch (error) {
      log(`the session ended with an error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.query = null;
      this.prompts.close();
      for (const entry of this.pending.values()) entry.settle({ behavior: "deny", message: "The session ended." });
      this.pending.clear();
      this.status = "exited";
      this.publish();
    }
  }

  prompt(text: string, images: readonly PromptImage[] = []): RunnerReply {
    if (this.status === "exited") return { ok: false, reason: "failed", message: "the session has ended" };
    this.prompts.push(this.userMessage(text, images));
    this.becomes("running");
    return { ok: true };
  }

  answer(answers: readonly TmuxQuestionAnswer[]): RunnerReply {
    const questions = [...this.pending.values()].filter(
      (entry): entry is Pending & { request: ClaudeSdkQuestionRequest } => entry.request.kind === "question",
    );
    if (questions.length === 0) return { ok: false, reason: "no-dialog", message: "no question is waiting" };
    let refusal: Extract<AnswersFit, { ok: false }> | null = null;
    for (const entry of questions) {
      const fit = sdkAnswers(entry.request.questions, answers);
      if (!fit.ok) {
        // A wrong option on the right call says more than a wrong call does, so it is kept.
        if (!refusal || fit.refused === "wrong-option") refusal = fit;
        continue;
      }
      this.settle(entry.request.toolUseId, {
        behavior: "allow",
        updatedInput: { questions: entry.request.questions, answers: fit.answers },
      });
      return { ok: true };
    }
    return { ok: false, reason: refusal!.refused, message: refusal!.message };
  }

  decide(toolUseId: string, allow: boolean, message?: string): RunnerReply {
    const entry = this.pending.get(toolUseId);
    if (!entry || entry.request.kind !== "approval") {
      return { ok: false, reason: "not-pending", message: "that approval is no longer waiting" };
    }
    this.settle(toolUseId, allow
      ? { behavior: "allow", updatedInput: entry.request.input }
      : { behavior: "deny", message: message?.trim() || DENIED_IN_PANEL });
    return { ok: true };
  }

  async setMode(mode: ClaudePermissionMode): Promise<RunnerReply> {
    if (!this.query) return { ok: false, reason: "failed", message: "the session is not running" };
    if (mode === "bypassPermissions" && !this.plan.allowBypass) {
      return { ok: false, reason: "invalid", message: "bypass permissions is not allowed for this session" };
    }
    try {
      await this.query.setPermissionMode(sdkPermissionMode(mode));
    } catch (error) {
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.permissionMode = mode;
    this.publish();
    return { ok: true };
  }

  /**
   * Renames the session the way `/rename` does -- registry name, title and agent name together
   * (measured 2026-10-17) -- through a control request rather than a turn, so it does not wait
   * behind a turn that is running.
   */
  async rename(title: string): Promise<RunnerReply> {
    if (!this.query) return { ok: false, reason: "failed", message: "the session is not running" };
    if (typeof this.query.renameSession !== "function") {
      return { ok: false, reason: "failed", message: "this SDK has no rename control request" };
    }
    try {
      await this.query.renameSession(title, this.plan.sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async interrupt(): Promise<RunnerReply> {
    if (!this.query) return { ok: false, reason: "failed", message: "the session is not running" };
    try {
      await this.query.interrupt();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Ends the session the way a terminal does when its pane is closed: the turn in progress is
   * interrupted, the input closes, and `claude` writes its exit records before it goes -- the
   * records a later resume picks its branch by.
   */
  async stop(): Promise<void> {
    if (this.status === "running" || this.status === "requires-action") await this.interrupt();
    this.prompts.close();
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const toolUseId = options.toolUseID;
    if (toolName === "AskUserQuestion") {
      const questions = askedQuestions(input);
      if (!questions) {
        return Promise.resolve({ behavior: "deny", message: "AskUserQuestion arrived without questions the panel can show." });
      }
      return this.hold({ kind: "question", toolUseId, questions, openedAt: this.now() }, options.signal);
    }
    const approval: ClaudeSdkApprovalRequest = {
      kind: "approval",
      toolUseId,
      toolName,
      input,
      openedAt: this.now(),
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(options.defaultToNo ? { defaultToNo: true } : {}),
    };
    return this.hold(approval, options.signal);
  };

  private hold(request: ClaudeSdkPendingRequest, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve) => {
      this.pending.set(request.toolUseId, { request, settle: resolve });
      // The SDK gives up on a request when the turn is interrupted, and nothing will answer it then.
      signal.addEventListener("abort", () => this.settle(request.toolUseId, { behavior: "deny", message: "Cancelled." }), {
        once: true,
      });
      this.publish();
    });
  }

  private settle(toolUseId: string, result: PermissionResult): void {
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    this.pending.delete(toolUseId);
    entry.settle(result);
    this.publish();
  }

  /**
   * The status, from what `claude` sends. Worked out here rather than read from the CLI's
   * `session_state_changed`, which the SDK documents and the CLI did not send in any run measured
   * on 2026-10-17 (2.1.302): a turn is running from its first streamed byte to its result.
   */
  private handle(message: SDKMessage): void {
    if (message.type === "stream_event") {
      const frame: RunnerStreamFrame = {
        type: "stream",
        event: message.event as unknown as RunnerStreamFrame["event"],
        parentToolUseId: message.parent_tool_use_id,
      };
      for (const listener of this.streamListeners) listener(frame);
    }
    if (message.type === "stream_event" || message.type === "assistant") {
      this.becomes("running");
      return;
    }
    if (message.type === "result") {
      this.becomes("idle");
      return;
    }
    if (message.type !== "system") return;
    switch (message.subtype) {
      case "init":
        this.permissionMode = cliPermissionMode(message.permissionMode);
        this.claudeCodeVersion = message.claude_code_version;
        if (this.status === "starting") this.status = "idle";
        break;
      case "status":
        if (message.permissionMode) this.permissionMode = cliPermissionMode(message.permissionMode) ?? this.permissionMode;
        break;
      case "session_state_changed":
        this.status = SESSION_STATES[message.state] ?? this.status;
        break;
      case "background_tasks_changed":
        this.backgroundTasks = message.tasks.length;
        break;
      default:
        return;
    }
    this.publish();
  }

  private becomes(status: ClaudeSdkRunStatus): void {
    if (this.status === status || this.status === "exited") return;
    this.status = status;
    this.publish();
  }

  private userMessage(text: string, images: readonly PromptImage[] = []): SDKUserMessage {
    // Images ahead of the words, which is how the API reads a picture followed by a question about it.
    const content = images.length === 0
      ? text
      : [
        ...images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
        })),
        { type: "text" as const, text },
      ];
    // `human` because the panel's composer is somebody at a keyboard; an unstamped message is
    // treated as unattributed and fails the CLI's isHuman() gates closed (the SDK's own note).
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } };
  }

  private publish(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
