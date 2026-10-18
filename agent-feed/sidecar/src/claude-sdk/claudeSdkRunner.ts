// One Claude session held through the Agent SDK: the part of the runner that is not a socket.
//
// A pipe, on purpose (ADR-0144). It owns the one long-lived `query()` the session runs in, fed by a
// queue so `claude` stays up between prompts, and it holds every permission callback open until a
// sidecar settles it -- the two things that must live in the process that owns `claude`. What any
// of it means -- the session's status, its mode, which call is a question -- is the sidecar's to
// read, because the sidecar reloads on a save and this process must not restart.
//
// It keeps the latest record of each kind (a message per type and subtype, a call per method) so a
// sidecar that connects late is handed enough to rebuild the session's state, and never more.
//
// Pure of I/O beyond the injected query, so its tests drive it with a fake SDK and no CLI.

import type { CanUseTool, Options, PermissionMode, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerCallback, RunnerChoices, RunnerRecord, RunnerReply } from "@/claude-sdk/claudeSdkProtocol";

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
  /** In the SDK's spelling: the CLI's `manual` is the SDK's `default`. */
  permissionMode: PermissionMode;
  allowBypass: boolean;
  pluginDirectories: string[];
  /** The installed `claude` this session runs. */
  claudePath: string;
  /** A first turn to send as soon as the query is open. */
  firstTurn?: string;
  /** The model and effort the session had chosen, which this launch starts with. */
  choices: RunnerChoices;
}

/** The SDK's `Query`, as far as the runner relies on it: messages out, and methods by name. */
export type RunnerQuery = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> };

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => RunnerQuery;

/** What the runner tells whoever is listening, in the order it happens. */
export type RunnerEvent =
  | { type: "record"; record: RunnerRecord }
  | { type: "callback"; callback: RunnerCallback }
  | { type: "settled"; callback: string };

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

/** Which record a new one replaces: one message per type and subtype, one call per method. */
function recordKey(record: RunnerRecord): string {
  switch (record.kind) {
    case "message":
      return `message:${record.message.type}:${String(record.message.subtype ?? "")}`;
    case "called":
      return `called:${record.method}`;
    default:
      return record.kind;
  }
}

function isSettings(args: unknown[]): args is [Record<string, unknown>] {
  return args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0]);
}

/** Only what survives JSON: `canUseTool`'s signal is the runner's to watch, not the sidecar's. */
function plainOptions(options: Parameters<CanUseTool>[2]): RunnerCallback["options"] {
  const { signal: _signal, ...rest } = options;
  return JSON.parse(JSON.stringify(rest)) as RunnerCallback["options"];
}

export class ClaudeSdkRunner {
  /** The latest record of each key, in the order each was last replaced. */
  private readonly records = new Map<string, RunnerRecord>();
  private readonly callbacks = new Map<string, { callback: RunnerCallback; settle: (result: PermissionResult) => void }>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly prompts = new PromptQueue();
  private query: RunnerQuery | null = null;
  private ended = false;
  private nextCallback = 0;

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
      permissionMode: plan.permissionMode,
      ...(plan.choices.model ? { model: plan.choices.model } : {}),
      ...(plan.choices.effort ? { effort: plan.choices.effort } : {}),
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

  get allowBypass(): boolean {
    return this.plan.allowBypass;
  }

  get choices(): RunnerChoices {
    return this.plan.choices;
  }

  /** Everything a connection arriving now is handed: the kept records, then the open callbacks. */
  snapshot(): { records: RunnerRecord[]; callbacks: RunnerCallback[] } {
    return { records: [...this.records.values()], callbacks: [...this.callbacks.values()].map((entry) => entry.callback) };
  }

  subscribe(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs the session until its input closes and `claude` exits. Resolves; never rejects. */
  async run(log: (line: string) => void): Promise<void> {
    this.query = this.createQuery({ prompt: this.prompts, options: this.options() });
    if (this.plan.firstTurn) {
      this.input({ type: "user", message: { role: "user", content: this.plan.firstTurn }, parent_tool_use_id: null, origin: { kind: "human" } });
    }
    try {
      for await (const message of this.query) {
        this.keep({ kind: "message", message: message as unknown as Record<string, unknown> & { type: string } });
      }
    } catch (error) {
      log(`the session ended with an error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.query = null;
      this.ended = true;
      this.prompts.close();
      for (const id of [...this.callbacks.keys()]) this.settle(id, { behavior: "deny", message: "The session ended." });
      this.keep({ kind: "ended" });
    }
  }

  /** Queues a turn, in the SDK's shape as the sidecar built it. */
  input(message: SDKUserMessage): RunnerReply {
    if (this.ended) return { ok: false, message: "the session has ended" };
    this.prompts.push(message);
    this.keep({ kind: "input" });
    return { ok: true, value: null };
  }

  /** Calls one control method of the `Query` by name, with whatever the sidecar sent. */
  async call(method: string, args: unknown[]): Promise<RunnerReply> {
    const query = this.query as unknown as Record<string, unknown> | null;
    if (!query) return { ok: false, message: "the session is not running" };
    const fn = query[method];
    if (typeof fn !== "function") return { ok: false, message: `this SDK has no ${method}` };
    try {
      const value: unknown = await (fn as (...values: unknown[]) => unknown).apply(query, args);
      this.keep({ kind: "called", method, args });
      return { ok: true, value: value ?? null };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Resolves one held callback, as the sidecar decided. */
  resolve(id: string, result: PermissionResult): RunnerReply {
    if (!this.callbacks.has(id)) return { ok: false, message: "that request is no longer waiting" };
    this.settle(id, result);
    return { ok: true, value: null };
  }

  /**
   * Ends the session the way a terminal does when its pane is closed: a turn in progress is
   * interrupted, the input closes, and `claude` writes its exit records before it goes -- the
   * records a later resume picks its branch by.
   */
  async stop(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
    this.prompts.close();
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise((resolve) => {
      const callback: RunnerCallback = {
        id: `cb${++this.nextCallback}`,
        toolName,
        input,
        options: plainOptions(options),
        openedAt: this.now(),
      };
      this.callbacks.set(callback.id, { callback, settle: resolve });
      // The SDK gives up on a request when the turn is interrupted, and nothing will answer it then.
      options.signal.addEventListener("abort", () => this.settle(callback.id, { behavior: "deny", message: "Cancelled." }), {
        once: true,
      });
      this.emit({ type: "callback", callback });
    });

  private settle(id: string, result: PermissionResult): void {
    const entry = this.callbacks.get(id);
    if (!entry) return;
    this.callbacks.delete(id);
    entry.settle(result);
    this.emit({ type: "settled", callback: id });
  }

  private keep(record: RunnerRecord): void {
    const key = recordKey(record);
    const before = this.records.get(key);
    // A method that takes one settings object layers its calls, as `applyFlagSettings` does, so the
    // kept call is all of them merged rather than only the last.
    if (record.kind === "called" && before?.kind === "called" && isSettings(record.args) && isSettings(before.args)) {
      record = { ...record, args: [{ ...before.args[0], ...record.args[0] }] };
    }
    this.records.delete(key);
    this.records.set(key, record);
    this.emit({ type: "record", record });
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
