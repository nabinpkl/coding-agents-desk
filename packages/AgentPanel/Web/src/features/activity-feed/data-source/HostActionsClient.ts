/**
 * The panel's native-authority client: everything the sidecar cannot answer.
 *
 * These requests do not read data. They write into ANOTHER application's window through
 * Accessibility, and they lease a PTY. That is why they keep the typed postMessage protocol the
 * feed just gave up: each one is a capability, the host bounds it on arrival, and changing one
 * should cost a Swift compile precisely because of what it can do.
 *
 * The split is by nature, not by convenience. `agent-http-*` is an opaque relay to a local HTTP
 * server; `agent-window-*` and `agent-terminal-*` are the host acting on the Mac.
 */

import type { HostBridge } from "./HostBridge";

export type AgentSource = string;

export interface AgentTerminalContext {
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

export interface AgentTerminalRequest {
  requestId: string;
  context: AgentTerminalContext;
}

export type AgentTerminalStatus =
  | (AgentTerminalRequest & { kind: "ready"; ptySessionName: string })
  | (AgentTerminalRequest & { kind: "error"; code: string })
  | (AgentTerminalRequest & { kind: "ended"; ptySessionName: string; exitStatus?: number });

/**
 * Live state of one session's Claude Desktop composer, as the host last resolved it.
 *
 * `reason` stays a plain string rather than a union: the host owns the code list, and a code this
 * build does not recognize has to degrade to "unavailable, reason unknown" rather than break the
 * field. The panel owns the WORDING for the codes it knows.
 */
export interface WindowComposerStatus {
  sessionId: string;
  enabled: boolean;
  reason: string | null;
  /** True when the owning window is already on the active Desktop, so reading costs no Space move. */
  onActiveDesktop: boolean;
  /** The composer's current text, present only when it was read without moving anything. */
  composerText: string | null;
}

/** A composer read or write that the host refused or could not complete. */
export class WindowComposerError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`window composer request failed: ${reason}`);
    this.name = "WindowComposerError";
    this.reason = reason;
  }
}

/**
 * The AskUserQuestion panel's live state in the session's Claude Desktop window, as the host last
 * read it. CONTENT is deliberately absent: the question text, options, and multi-select shape come
 * from the transcript feed's `AskUserQuestion` tool_use, and this only augments it with what a live
 * AX read adds -- selection, the Other input, Submit's enabled state, and presence.
 */
export interface QuestionPanelStatus {
  sessionId: string;
  enabled: boolean;
  reason: string | null;
  /** True when the owning window is already on the active Desktop, so AX reads cost no Space move. */
  onActiveDesktop: boolean;
  /**
   * Whether an AskUserQuestion panel exists in the window's tree. null when the window is on another
   * Desktop, where Chromium builds no tree to read -- the mirror keeps its JSON content either way.
   */
  present: boolean | null;
  /** Indices (into the JSON `options` array) currently selected or checked in the panel. */
  selected: number[];
  /** The panel's "Other" input value, or null when empty or unreadable. */
  otherText: string | null;
  /** The panel's Submit button enabled state, or null when unreadable. */
  submitEnabled: boolean | null;
}

/** A question action the host refused or could not complete. */
export class WindowQuestionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`window question action failed: ${reason}`);
    this.name = "WindowQuestionError";
    this.reason = reason;
  }
}

interface Watch<T> {
  sessionId: string;
  listener: (status: T) => void;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HostActionsClientOptions {
  /** How long a composer or question action may take before it is abandoned. */
  actionTimeoutMs?: number;
  requestIDFactory?: (prefix: string) => string;
}

let nextRequestOrdinal = 0;

function defaultRequestID(prefix: string): string {
  nextRequestOrdinal += 1;
  return `${prefix}-${nextRequestOrdinal}`;
}

function questionStatus(
  message: {
    sid: string;
    en?: boolean;
    r?: string | null;
    cur?: boolean;
    pr?: boolean | null;
    sel?: number[];
    oth?: string | null;
    sb?: boolean | null;
  },
  sessionId = message.sid,
): QuestionPanelStatus {
  return {
    sessionId,
    enabled: message.en === true,
    reason: typeof message.r === "string" ? message.r : null,
    onActiveDesktop: message.cur === true,
    present: typeof message.pr === "boolean" ? message.pr : null,
    selected: Array.isArray(message.sel) ? message.sel : [],
    otherText: typeof message.oth === "string" ? message.oth : null,
    submitEnabled: typeof message.sb === "boolean" ? message.sb : null,
  };
}

function terminalContext(value: unknown): AgentTerminalContext | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = raw.src;
  if (typeof raw.pp !== "string" || raw.pp.length === 0) return null;
  if (source !== "claude" && source !== "codex") return null;
  if (typeof raw.sid !== "string" || raw.sid.length === 0) return null;
  return { projectPath: raw.pp, source, sessionId: raw.sid };
}

function sameTerminalRequest(a: AgentTerminalRequest, b: AgentTerminalRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.context.projectPath === b.context.projectPath &&
    a.context.source === b.context.source &&
    a.context.sessionId === b.context.sessionId
  );
}

export class HostActionsClient {
  private readonly actionTimeoutMs: number;
  private readonly requestID: (prefix: string) => string;
  private readonly composerWatches = new Map<string, Watch<WindowComposerStatus>>();
  private readonly composerWaiters = new Map<string, Waiter<string>>();
  private readonly questionWatches = new Map<string, Watch<QuestionPanelStatus>>();
  private readonly questionWaiters = new Map<string, Waiter<QuestionPanelStatus>>();
  private readonly terminalListeners = new Set<(status: AgentTerminalStatus) => void>();
  private activeTerminalRequest: AgentTerminalRequest | null = null;
  private detach: (() => void) | null;
  private destroyed = false;

  constructor(
    private readonly bridge: HostBridge,
    options: HostActionsClientOptions = {},
  ) {
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.requestID = options.requestIDFactory ?? defaultRequestID;
    this.detach = bridge.onHostMessage((message) => this.receive(message));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detach?.();
    this.detach = null;
    for (const waiter of this.composerWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("host actions client destroyed"));
    }
    this.composerWaiters.clear();
    for (const waiter of this.questionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("host actions client destroyed"));
    }
    this.questionWaiters.clear();
    this.composerWatches.clear();
    this.questionWatches.clear();
    this.terminalListeners.clear();
  }

  // ---------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------

  subscribeWindowComposer(
    sessionId: string,
    listener: (status: WindowComposerStatus) => void,
  ): () => void {
    if (this.destroyed) return () => {};
    const subscriptionId = this.requestID("window-input");
    this.composerWatches.set(subscriptionId, { sessionId, listener });
    this.bridge.postToHost({ t: "agent-window-input-watch", sub: subscriptionId, sid: sessionId });
    return () => {
      if (!this.composerWatches.delete(subscriptionId)) return;
      this.bridge.postToHost({ t: "agent-window-input-unwatch", sub: subscriptionId });
    };
  }

  /**
   * Fills the session's composer with `text` and resolves with what the host read back.
   *
   * Fill only. Nothing on this path presses Return: the human still sends from the real window, and
   * can edit first. Resolving with the read-back rather than void is what makes that verifiable --
   * the host compares it to what it wrote and fails the request when they differ.
   */
  syncWindowComposer(sessionId: string, text: string): Promise<string> {
    const rid = this.requestID("window-sync");
    return this.awaitComposer(rid, { t: "agent-window-input-sync", rid, sid: sessionId, tx: text });
  }

  /**
   * Fills the session's composer with `text` and presses Return, committing the prompt in Claude
   * Desktop. The only path that sends, so it fronts the owning window. Resolves with the composer
   * value read after the send, which a successful submit clears to the empty string.
   */
  submitWindowComposer(sessionId: string, text: string): Promise<string> {
    const rid = this.requestID("window-submit");
    return this.awaitComposer(rid, { t: "agent-window-input-submit", rid, sid: sessionId, tx: text });
  }

  /**
   * Reads the session's composer, moving its window to the active Desktop if it is not already
   * there. Explicit because that move is visible on the Mac; the free case is already answered by
   * `composerText` on the watch status.
   */
  readWindowComposer(sessionId: string): Promise<string> {
    const rid = this.requestID("window-read");
    return this.awaitComposer(rid, { t: "agent-window-input-read", rid, sid: sessionId });
  }

  private awaitComposer(rid: string, message: Record<string, unknown>): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error("host actions client destroyed"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.composerWaiters.delete(rid);
        reject(new Error(`window composer request timed out: ${rid}`));
      }, this.actionTimeoutMs);
      this.composerWaiters.set(rid, { resolve, reject, timer });
      this.bridge.postToHost(message);
    });
  }

  // ---------------------------------------------------------------------
  // AskUserQuestion mirror
  // ---------------------------------------------------------------------

  /**
   * Watches one session's AskUserQuestion panel state. Focus-gated by the caller exactly like the
   * composer watch: the host's AX poll only runs while a panel the user is looking at keeps a watch
   * alive.
   */
  subscribeWindowQuestion(
    sessionId: string,
    listener: (status: QuestionPanelStatus) => void,
  ): () => void {
    if (this.destroyed) return () => {};
    const subscriptionId = this.requestID("question");
    this.questionWatches.set(subscriptionId, { sessionId, listener });
    this.bridge.postToHost({ t: "agent-window-question-watch", sub: subscriptionId, sid: sessionId });
    return () => {
      if (!this.questionWatches.delete(subscriptionId)) return;
      this.bridge.postToHost({ t: "agent-window-question-unwatch", sub: subscriptionId });
    };
  }

  /**
   * Presses (or un-presses, per `desired`) the panel option at `option`. `desired` is ignored by
   * single-select panels, whose options cannot be un-pressed. The host presses only on mismatch, so
   * retrying is idempotent.
   */
  selectQuestionOption(sessionId: string, option: number, desired: boolean): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "select", oi: option, v: desired ? 1 : 0 });
  }

  /** Types `text` into the panel's "Other" input. Empty text clears it. */
  setQuestionOther(sessionId: string, text: string): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "other", tx: text });
  }

  submitQuestion(sessionId: string): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "submit" });
  }

  skipQuestion(sessionId: string): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "skip" });
  }

  dismissQuestion(sessionId: string): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "dismiss" });
  }

  toggleQuestionOptions(sessionId: string): Promise<QuestionPanelStatus> {
    return this.awaitQuestion(sessionId, { k: "view-options" });
  }

  private awaitQuestion(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<QuestionPanelStatus> {
    if (this.destroyed) return Promise.reject(new Error("host actions client destroyed"));
    const rid = this.requestID("question-action");
    return new Promise<QuestionPanelStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.questionWaiters.delete(rid);
        reject(new Error(`window question action timed out: ${rid}`));
      }, this.actionTimeoutMs);
      this.questionWaiters.set(rid, { resolve, reject, timer });
      this.bridge.postToHost({ t: "agent-window-question-action", rid, sid: sessionId, ...payload });
    });
  }

  // ---------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------

  createTerminalRequest(context: AgentTerminalContext): AgentTerminalRequest {
    return { requestId: this.requestID("terminal"), context };
  }

  openTerminal(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    if (this.activeTerminalRequest && !sameTerminalRequest(this.activeTerminalRequest, request)) {
      this.endTerminalContext(this.activeTerminalRequest);
    }
    this.activeTerminalRequest = request;
    this.postTerminalIntent("agent-terminal-open", request);
  }

  closeTerminal(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    this.postTerminalIntent("agent-terminal-close", request);
  }

  endTerminalContext(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    this.postTerminalIntent("agent-terminal-context-ended", request);
    if (this.activeTerminalRequest && sameTerminalRequest(this.activeTerminalRequest, request)) {
      this.activeTerminalRequest = null;
    }
  }

  endActiveTerminalContext(): void {
    if (this.activeTerminalRequest) this.endTerminalContext(this.activeTerminalRequest);
  }

  subscribeTerminalStatus(listener: (status: AgentTerminalStatus) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  private postTerminalIntent(tag: string, request: AgentTerminalRequest): void {
    this.bridge.postToHost({
      t: tag,
      rid: request.requestId,
      ctx: {
        pp: request.context.projectPath,
        src: request.context.source,
        sid: request.context.sessionId,
      },
    });
  }

  /**
   * Re-issues every live watch after a reconnect.
   *
   * Load-bearing on the phone, where a reconnect is a new input lane and the host dropped this
   * device's composer and question sinks with the old one. Without this the field would keep
   * whatever status it last had and never update again -- reading as writable when it may no longer
   * be. The feed needs no equivalent: a relayed subscription that dies fails its request, and the
   * panel re-opens it.
   */
  resumeAfterSessionReconnect(): void {
    if (this.destroyed) return;
    for (const [sub, watch] of this.composerWatches) {
      this.bridge.postToHost({ t: "agent-window-input-watch", sub, sid: watch.sessionId });
    }
    for (const [sub, watch] of this.questionWatches) {
      this.bridge.postToHost({ t: "agent-window-question-watch", sub, sid: watch.sessionId });
    }
  }

  // ---------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------

  private receive(message: unknown): void {
    if (this.destroyed) return;
    if (typeof message !== "object" || message === null) return;
    const frame = message as Record<string, unknown> & { t?: string };
    switch (frame.t) {
      case "agent-window-input-status": {
        const watch = this.composerWatches.get(frame.sub as string);
        // A status for a session this subscription is no longer watching would prefill the field
        // from the wrong window. The host re-resolves on a timer, so a stale one can land after a
        // switch.
        if (!watch || watch.sessionId !== frame.sid) return;
        watch.listener({
          sessionId: frame.sid as string,
          enabled: frame.en === true,
          reason: typeof frame.r === "string" ? frame.r : null,
          onActiveDesktop: frame.cur === true,
          composerText: typeof frame.tx === "string" ? frame.tx : null,
        });
        return;
      }
      case "agent-window-input-result": {
        const waiter = this.composerWaiters.get(frame.rid as string);
        if (!waiter) return;
        this.composerWaiters.delete(frame.rid as string);
        clearTimeout(waiter.timer);
        if (frame.ok !== true) {
          waiter.reject(
            new WindowComposerError(typeof frame.r === "string" && frame.r ? frame.r : "unknown"),
          );
          return;
        }
        // A successful result always carries the observed text, including the empty string after a
        // clear. Only a missing field is a malformed reply.
        if (typeof frame.tx !== "string") {
          waiter.reject(new Error("window composer result carried no text"));
          return;
        }
        waiter.resolve(frame.tx);
        return;
      }
      case "agent-window-question-status": {
        const watch = this.questionWatches.get(frame.sub as string);
        if (!watch || watch.sessionId !== frame.sid) return;
        watch.listener(questionStatus(frame as never));
        return;
      }
      case "agent-window-question-result": {
        const waiter = this.questionWaiters.get(frame.rid as string);
        if (!waiter) return;
        this.questionWaiters.delete(frame.rid as string);
        clearTimeout(waiter.timer);
        if (frame.ok !== true) {
          waiter.reject(
            new WindowQuestionError(typeof frame.r === "string" && frame.r ? frame.r : "unknown"),
          );
          return;
        }
        // A result is the read-back of an action the host just performed, so reachability is not
        // in question: it reached the panel. `enabled`/`onActiveDesktop` are properties of a
        // *status* poll, and a result carries neither -- reading them off this frame would report
        // the window as unreachable immediately after successfully pressing a button in it.
        waiter.resolve({
          sessionId: frame.sid as string,
          enabled: true,
          reason: null,
          onActiveDesktop: true,
          present: typeof frame.pr === "boolean" ? frame.pr : null,
          selected: Array.isArray(frame.sel) ? (frame.sel as number[]) : [],
          otherText: typeof frame.oth === "string" ? frame.oth : null,
          submitEnabled: typeof frame.sb === "boolean" ? frame.sb : null,
        });
        return;
      }
      case "agent-terminal-ready":
      case "agent-terminal-error":
      case "agent-terminal-ended": {
        const status = this.terminalStatus(frame);
        if (status) for (const listener of this.terminalListeners) listener(status);
        return;
      }
      default:
        return;
    }
  }

  private terminalStatus(frame: Record<string, unknown>): AgentTerminalStatus | null {
    const requestId = frame.rid;
    const context = terminalContext(frame.ctx);
    if (typeof requestId !== "string" || requestId.length === 0 || !context) return null;
    if (frame.t === "agent-terminal-ready") {
      if (typeof frame.psn !== "string" || frame.psn.length === 0) return null;
      return { kind: "ready", requestId, context, ptySessionName: frame.psn };
    }
    if (frame.t === "agent-terminal-error") {
      if (typeof frame.c !== "string" || frame.c.length === 0) return null;
      return { kind: "error", requestId, context, code: frame.c };
    }
    if (typeof frame.psn !== "string" || frame.psn.length === 0) return null;
    if (frame.xs !== undefined && typeof frame.xs !== "number") return null;
    return {
      kind: "ended",
      requestId,
      context,
      ptySessionName: frame.psn,
      exitStatus: frame.xs as number | undefined,
    };
  }
}
