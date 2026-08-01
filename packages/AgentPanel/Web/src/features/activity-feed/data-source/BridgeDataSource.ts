import type {
  ActivityBlock,
  ActivityEvent,
  TokenUsage,
} from "../useSessionEventsStream";
import { normalizeActivityEvent } from "../activityNormalization";
import type {
  AgentDataSource,
  AgentSource,
  EventMode,
  EventsPage,
  SessionEventsHandlers,
  SessionReference,
} from "./AgentDataSource";
import type { HostBridge } from "./HostBridge";

interface WireActivityBlock {
  k: string;
  lb?: string;
  tx?: string;
  tl?: string;
  sm?: string;
  pv?: string;
  ci?: string;
  in?: Record<string, unknown>;
  hc?: number;
  hl?: number;
}

interface WireActivityEvent {
  id: string;
  i: number;
  rev: number;
  ph: "streaming" | "complete" | "error";
  ts: number;
  tp: string;
  b: WireActivityBlock[];
  xi?: number | null;
}

interface WireProjectSummary {
  pp: string;
  dn: string;
  sc: Record<string, number>;
  sn: number;
  lea: number;
}

interface WireSessionSummary {
  sid: string;
  src: AgentSource;
  ttl: string;
  lea: number;
  ac: SessionActivity;
  cap: WireSessionCapabilities;
}

interface WireSessionCapabilities {
  md: EventMode[];
  snd: boolean;
  str: boolean;
  abt: boolean;
  raw: boolean;
  pty: boolean;
  xui: boolean;
}

interface WireProjectsPush {
  t: "agent-projects";
  sub: string;
  p: WireProjectSummary[];
}

interface WireProjectsError {
  t: "agent-projects-error";
  sub: string;
  r: string;
}

interface WireProjectSessionsPush {
  t: "agent-project-sessions";
  sub: string;
  pp: string;
  ss: WireSessionSummary[];
}

interface WireProjectSessionsError {
  t: "agent-project-sessions-error";
  sub: string;
  pp: string;
  r: string;
}

interface WireTokenUsage {
  cur: number;
  lim?: number | null;
  ua: number;
  mdl?: string;
}

interface WireThreadChunk {
  t: "agent-thread-chunk";
  src: AgentSource;
  sid: string;
  ev: WireActivityEvent[];
  ws: number;
  tot: number;
  lv: boolean;
  u?: WireTokenUsage | null;
  md?: EventMode;
  k: "snapshot" | "page" | "upsert" | "state";
  seq: number;
  rs?: AgentRunState;
  qs: number;
  qf: number;
}

type AgentRunState = "idle" | "running" | "ended" | "error";

interface WireThreadError {
  t: "agent-thread-error";
  src: AgentSource;
  sid: string;
  r: string;
}

interface WireAgentTerminalContext {
  pp: string;
  src: AgentSource;
  sid: string;
}

interface WireRawEvent {
  t: "agent-raw-event";
  rid: string;
  src: AgentSource;
  sid: string;
  ei: number;
  tx: string;
}

interface WireRawEventError {
  t: "agent-raw-event-error";
  rid: string;
  src: AgentSource;
  sid: string;
  ei: number;
  r: string;
}

interface WireCommandReceipt {
  t: "agent-command-receipt";
  rid: string;
  src: AgentSource;
  sid: string;
  del: string;
  s?: WireSessionSummary;
}

interface WireCommandError {
  t: "agent-command-error";
  rid: string;
  c: string;
  m: string;
  rt: boolean;
}

export interface AgentExtensionUIRequest {
  source: AgentSource;
  sessionId: string;
  requestId: string;
  kind: "select" | "confirm" | "input" | "editor" | "notify" | "status" | "widget";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  level?: "info" | "warning" | "error";
  key?: string;
  lines?: string[];
  expectsResponse: boolean;
}

interface WireExtensionUIRequest {
  t: "agent-extension-ui-request";
  src: AgentSource;
  sid: string;
  rid: string;
  k: AgentExtensionUIRequest["kind"];
  ttl?: string;
  m?: string;
  o?: string[];
  ph?: string;
  pf?: string;
  lv?: AgentExtensionUIRequest["level"];
  key?: string;
  ln?: string[];
  er: boolean;
}

interface WireExtensionUIDismissed {
  t: "agent-extension-ui-dismissed";
  src: AgentSource;
  sid: string;
  rid: string;
}

type InboundMessage =
  | WireProjectsPush
  | WireProjectsError
  | WireProjectSessionsPush
  | WireProjectSessionsError
  | WireThreadChunk
  | WireThreadError
  | WireRawEvent
  | WireRawEventError
  | WireCommandReceipt
  | WireCommandError
  | WireExtensionUIRequest
  | WireExtensionUIDismissed
  | { t: string };

export type SessionActivity = "live" | "ready" | "paused" | "cold";

export interface BridgeProject {
  projectPath: string;
  displayName: string;
  sourceCounts: Record<string, number>;
  sessionCount: number;
  lastEventAt: number;
}

export interface BridgeSessionSummary {
  sessionId: string;
  source: AgentSource;
  title: string;
  lastEventAt: number;
  activity: SessionActivity;
  capabilities: AgentSessionCapabilities;
}

export interface AgentSessionCapabilities {
  modes: EventMode[];
  canSend: boolean;
  canSteer: boolean;
  canAbort: boolean;
  canFetchRaw: boolean;
  canOpenTerminal: boolean;
  supportsExtensionUI: boolean;
}

export interface AgentCommandReceipt {
  requestId: string;
  source: AgentSource;
  sessionId: string;
  delivery: string;
  session?: BridgeSessionSummary;
}

export type AgentExtensionUIEvent =
  | { type: "request"; request: AgentExtensionUIRequest }
  | {
      type: "dismiss";
      source: AgentSource;
      sessionId: string;
      requestId: string;
    };

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
  | (AgentTerminalRequest & {
      kind: "ended";
      ptySessionName: string;
      exitStatus?: number;
    });

interface BridgeDataSourceOptions {
  olderPageTimeoutMs?: number;
  rawEventTimeoutMs?: number;
  requestIDFactory?: (prefix: string) => string;
}

interface SessionBuffer {
  events: Map<number, ActivityEvent>;
  total: number;
  windowStart: number;
  usage: TokenUsage | null;
  /** The view every index in this buffer is counted in. */
  mode: EventMode;
  seeded: boolean;
  sequence: number;
  runState: AgentRunState;
  queue: { steer: number; followUp: number };
}

interface SeedWaiter {
  resolve: (buffer: SessionBuffer) => void;
  reject: (error: Error) => void;
}

interface OlderWaiter {
  sessionKey: string;
  resolve: (chunk: WireThreadChunk) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RawEventWaiter {
  sessionKey: string;
  eventIndex: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CommandWaiter {
  resolve: (receipt: AgentCommandReceipt) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProjectWatch {
  onSnapshot: (projects: BridgeProject[]) => void;
  onError?: (reason: string) => void;
}

interface ProjectSessionsWatch {
  projectPath: string;
  onSnapshot: (sessions: BridgeSessionSummary[]) => void;
  onError?: (reason: string) => void;
}

function mapBlock(wire: WireActivityBlock): ActivityBlock {
  return {
    kind: wire.k as ActivityBlock["kind"],
    label: wire.lb,
    text: wire.tx,
    tool: wire.tl,
    summary: wire.sm,
    preview: wire.pv,
    callId: wire.ci,
    input: wire.in,
    hiddenChars: wire.hc,
    hiddenLines: wire.hl,
  };
}

// Validated rather than cast: the numbers drive a fill bar, and a malformed
// `cur` would render a NaN-wide element rather than failing anywhere visible.
// An absent `lim` and an explicit null are the same answer -- no window known.
function mapUsage(wire: WireTokenUsage | null | undefined): TokenUsage | null {
  if (!wire || typeof wire.cur !== "number" || !Number.isFinite(wire.cur)) {
    return null;
  }
  const limit =
    typeof wire.lim === "number" && Number.isFinite(wire.lim) && wire.lim > 0
      ? wire.lim
      : null;
  return {
    current: wire.cur,
    limit,
    updatedAt: typeof wire.ua === "number" ? wire.ua : 0,
    ...(typeof wire.mdl === "string" && wire.mdl ? { model: wire.mdl } : {}),
  };
}

function mapEvent(wire: WireActivityEvent): ActivityEvent {
  return normalizeActivityEvent({
    id: wire.id,
    index: wire.i,
    revision: wire.rev,
    phase: wire.ph,
    ts: wire.ts,
    type: wire.tp,
    blocks: wire.b.map(mapBlock),
    otherModeIndex: typeof wire.xi === "number" ? wire.xi : null,
  });
}

function mapSession(wire: WireSessionSummary): BridgeSessionSummary {
  return {
    sessionId: wire.sid,
    source: wire.src,
    title: wire.ttl,
    lastEventAt: wire.lea,
    activity: wire.ac,
    capabilities: {
      modes: wire.cap.md,
      canSend: wire.cap.snd,
      canSteer: wire.cap.str,
      canAbort: wire.cap.abt,
      canFetchRaw: wire.cap.raw,
      canOpenTerminal: wire.cap.pty,
      supportsExtensionUI: wire.cap.xui,
    },
  };
}

// Deliberately NOT keyed by mode. The host keys its thread streams by source and
// session too, so a key that included the mode would let the panel believe it holds
// two independent subscriptions while the host has replaced one with the other. The
// panel runs one mode at a time; a chunk answering the mode it just left is dropped
// by comparing `chunk.md` against the buffer's, which is the check that actually
// prevents two views' indices from merging.
function sessionKey(session: SessionReference): string {
  return `${session.source}:${session.sessionId}`;
}

let fallbackRequestSequence = 0;

function createRequestID(prefix: string): string {
  try {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return `${prefix}-${Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
    }
  } catch {
    // WKWebView can expose a partial Crypto object on custom schemes.
  }
  fallbackRequestSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapTerminalContext(value: unknown): AgentTerminalContext | null {
  if (!isRecord(value)) return null;
  const projectPath = value.pp;
  const source = value.src;
  const sessionId = value.sid;
  if (
    typeof projectPath !== "string" ||
    projectPath.length === 0 ||
    (source !== "claude" && source !== "codex") ||
    typeof sessionId !== "string" ||
    sessionId.length === 0
  ) {
    return null;
  }
  return { projectPath, source, sessionId };
}

function wireTerminalContext(context: AgentTerminalContext): WireAgentTerminalContext {
  return {
    pp: context.projectPath,
    src: context.source,
    sid: context.sessionId,
  };
}

function sameTerminalRequest(
  lhs: AgentTerminalRequest,
  rhs: AgentTerminalRequest,
): boolean {
  return (
    lhs.requestId === rhs.requestId &&
    lhs.context.projectPath === rhs.context.projectPath &&
    lhs.context.source === rhs.context.source &&
    lhs.context.sessionId === rhs.context.sessionId
  );
}

export class BridgeDataSource implements AgentDataSource {
  private readonly bridge: HostBridge;
  private readonly olderPageTimeoutMs: number;
  private readonly rawEventTimeoutMs: number;
  private readonly requestIDFactory: (prefix: string) => string;
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly liveListeners = new Map<
    string,
    Set<SessionEventsHandlers>
  >();
  private readonly seedWaiters = new Map<string, SeedWaiter[]>();
  private readonly olderWaiters = new Map<string, OlderWaiter[]>();
  private readonly rawEventWaiters = new Map<string, RawEventWaiter>();
  private readonly commandWaiters = new Map<string, CommandWaiter>();
  private readonly activeThreads = new Map<string, SessionReference>();
  private readonly reconnectingThreads = new Set<string>();
  private readonly projectWatches = new Map<string, ProjectWatch>();
  private readonly projectSessionsWatches = new Map<
    string,
    ProjectSessionsWatch
  >();
  private readonly terminalStatusListeners = new Set<
    (status: AgentTerminalStatus) => void
  >();
  private readonly extensionUIListeners = new Set<
    (event: AgentExtensionUIEvent) => void
  >();
  private activeTerminalRequest: AgentTerminalRequest | null = null;
  private unsubscribeHostMessages: (() => void) | null;
  private destroyed = false;

  constructor(bridge: HostBridge, options: BridgeDataSourceOptions = {}) {
    this.bridge = bridge;
    this.olderPageTimeoutMs = options.olderPageTimeoutMs ?? 10_000;
    this.rawEventTimeoutMs = options.rawEventTimeoutMs ?? 35_000;
    this.requestIDFactory = options.requestIDFactory ?? createRequestID;
    this.unsubscribeHostMessages = bridge.onHostMessage((message) => {
      this.handleInbound(message as InboundMessage);
    });
  }

  subscribeProjects(
    onSnapshot: (projects: BridgeProject[]) => void,
    onError?: (reason: string) => void,
  ): () => void {
    if (this.destroyed) return () => {};
    const subscriptionId = this.requestIDFactory("projects");
    this.projectWatches.set(subscriptionId, { onSnapshot, onError });
    this.bridge.postToHost({
      t: "agent-projects-watch",
      sub: subscriptionId,
    });
    return () => {
      if (!this.projectWatches.delete(subscriptionId)) return;
      this.bridge.postToHost({
        t: "agent-projects-unwatch",
        sub: subscriptionId,
      });
    };
  }

  subscribeProjectSessions(
    projectPath: string,
    onSnapshot: (sessions: BridgeSessionSummary[]) => void,
    onError?: (reason: string) => void,
  ): () => void {
    if (this.destroyed) return () => {};
    const subscriptionId = this.requestIDFactory("project-sessions");
    this.projectSessionsWatches.set(subscriptionId, {
      projectPath,
      onSnapshot,
      onError,
    });
    this.bridge.postToHost({
      t: "agent-project-sessions-watch",
      sub: subscriptionId,
      pp: projectPath,
    });
    return () => {
      if (!this.projectSessionsWatches.delete(subscriptionId)) return;
      this.bridge.postToHost({
        t: "agent-project-sessions-unwatch",
        sub: subscriptionId,
      });
    };
  }

  fetchEventsPage(
    session: SessionReference,
    offset: number,
    limit: number,
  ): Promise<EventsPage> {
    if (this.destroyed) {
      return Promise.reject(new Error("BridgeDataSource destroyed"));
    }
    const key = sessionKey(session);
    const buffer = this.buffers.get(key);
    if (buffer?.seeded && offset < buffer.windowStart) {
      return this.fetchOlderPage(session, offset + limit, limit);
    }
    if (buffer?.seeded) {
      return Promise.resolve(this.pageFromBuffer(buffer, offset, limit));
    }
    this.ensureThreadSubscription(session);
    return new Promise<EventsPage>((resolve, reject) => {
      const waiters = this.seedWaiters.get(key) ?? [];
      waiters.push({
        resolve: (seeded) => resolve(this.pageFromBuffer(seeded, offset, limit)),
        reject,
      });
      this.seedWaiters.set(key, waiters);
    });
  }

  subscribeSessionEvents(
    session: SessionReference,
    _after: number,
    handlers: SessionEventsHandlers,
  ): () => void {
    if (this.destroyed) return () => {};
    const key = sessionKey(session);
    const listeners = this.liveListeners.get(key) ?? new Set();
    const firstListener = listeners.size === 0;
    listeners.add(handlers);
    this.liveListeners.set(key, listeners);
    if (firstListener) this.ensureThreadSubscription(session);
    handlers.onOpen?.();

    return () => {
      const current = this.liveListeners.get(key);
      current?.delete(handlers);
      if (current && current.size > 0) return;
      this.liveListeners.delete(key);
      this.closeThreadSubscription(session);
      this.rejectSessionWaiters(key, new Error("thread subscription closed"));
      this.buffers.delete(key);
    };
  }

  fetchRawEvent(
    session: SessionReference,
    eventIndex: number,
  ): Promise<string> {
    if (this.destroyed) {
      return Promise.reject(new Error("BridgeDataSource destroyed"));
    }
    const requestId = this.requestIDFactory("raw");
    const key = sessionKey(session);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rawEventWaiters.delete(requestId);
        reject(
          new Error(
            `raw event request timed out for ${key} event ${eventIndex}`,
          ),
        );
      }, this.rawEventTimeoutMs);
      this.rawEventWaiters.set(requestId, {
        sessionKey: key,
        eventIndex,
        resolve,
        reject,
        timer,
      });
      this.bridge.postToHost({
        t: "agent-raw-event-get",
        rid: requestId,
        src: session.source,
        sid: session.sessionId,
        ei: eventIndex,
        md: session.mode,
      });
    });
  }

  createSession(projectPath: string, source: AgentSource = "pi"): Promise<AgentCommandReceipt> {
    const requestId = this.requestIDFactory("create");
    return this.postCommand(requestId, {
      t: "agent-session-create",
      rid: requestId,
      src: source,
      pp: projectPath,
    });
  }

  sendMessage(
    session: Pick<SessionReference, "source" | "sessionId">,
    text: string,
    delivery: "next" | "steer",
  ): Promise<AgentCommandReceipt> {
    const requestId = this.requestIDFactory("send");
    return this.postCommand(requestId, {
      t: "agent-session-send",
      rid: requestId,
      src: session.source,
      sid: session.sessionId,
      tx: text,
      del: delivery,
    });
  }

  abortSession(
    session: Pick<SessionReference, "source" | "sessionId">,
  ): Promise<AgentCommandReceipt> {
    const requestId = this.requestIDFactory("abort");
    return this.postCommand(requestId, {
      t: "agent-session-abort",
      rid: requestId,
      src: session.source,
      sid: session.sessionId,
    });
  }

  respondToExtensionUI(
    request: AgentExtensionUIRequest,
    value: string | boolean | null,
  ): Promise<AgentCommandReceipt> {
    return this.postCommand(request.requestId, {
      t: "agent-extension-ui-response",
      src: request.source,
      sid: request.sessionId,
      rid: request.requestId,
      v: value,
    });
  }

  subscribeExtensionUI(
    listener: (event: AgentExtensionUIEvent) => void,
  ): () => void {
    this.extensionUIListeners.add(listener);
    return () => this.extensionUIListeners.delete(listener);
  }

  private postCommand(
    requestId: string,
    message: Record<string, unknown>,
  ): Promise<AgentCommandReceipt> {
    if (this.destroyed) return Promise.reject(new Error("BridgeDataSource destroyed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commandWaiters.delete(requestId);
        reject(new Error(`agent command timed out: ${requestId}`));
      }, this.rawEventTimeoutMs);
      this.commandWaiters.set(requestId, { resolve, reject, timer });
      this.bridge.postToHost(message);
    });
  }

  createTerminalRequest(context: AgentTerminalContext): AgentTerminalRequest {
    return {
      requestId: this.requestIDFactory("terminal"),
      context,
    };
  }

  openTerminal(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    if (
      this.activeTerminalRequest &&
      !sameTerminalRequest(this.activeTerminalRequest, request)
    ) {
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
    if (
      this.activeTerminalRequest &&
      sameTerminalRequest(this.activeTerminalRequest, request)
    ) {
      this.activeTerminalRequest = null;
    }
  }

  endActiveTerminalContext(): void {
    if (this.activeTerminalRequest) {
      this.endTerminalContext(this.activeTerminalRequest);
    }
  }

  subscribeTerminalStatus(
    listener: (status: AgentTerminalStatus) => void,
  ): () => void {
    this.terminalStatusListeners.add(listener);
    return () => this.terminalStatusListeners.delete(listener);
  }

  resumeAfterSessionReconnect(): void {
    if (this.destroyed) return;
    for (const subscriptionId of this.projectWatches.keys()) {
      this.bridge.postToHost({
        t: "agent-projects-watch",
        sub: subscriptionId,
      });
    }
    for (const [subscriptionId, watch] of this.projectSessionsWatches) {
      this.bridge.postToHost({
        t: "agent-project-sessions-watch",
        sub: subscriptionId,
        pp: watch.projectPath,
      });
    }
    for (const session of this.activeThreads.values()) {
      this.reconnectingThreads.add(sessionKey(session));
      this.bridge.postToHost({
        t: "agent-thread-sub",
        src: session.source,
        sid: session.sessionId,
        md: session.mode,
      });
    }
  }

  private ensureThreadSubscription(session: SessionReference): void {
    const key = sessionKey(session);
    if (this.activeThreads.has(key)) return;
    this.activeThreads.set(key, session);
    this.buffers.set(key, {
      events: new Map(),
      total: 0,
      windowStart: 0,
      usage: null,
      mode: session.mode,
      seeded: false,
      sequence: 0,
      runState: "idle",
      queue: { steer: 0, followUp: 0 },
    });
    this.bridge.postToHost({
      t: "agent-thread-sub",
      src: session.source,
      sid: session.sessionId,
      md: session.mode,
    });
  }

  private closeThreadSubscription(session: SessionReference): void {
    const key = sessionKey(session);
    if (!this.activeThreads.delete(key)) return;
    this.reconnectingThreads.delete(key);
    this.bridge.postToHost({
      t: "agent-thread-unsub",
      src: session.source,
      sid: session.sessionId,
    });
  }

  private postTerminalIntent(
    type:
      | "agent-terminal-open"
      | "agent-terminal-close"
      | "agent-terminal-context-ended",
    request: AgentTerminalRequest,
  ): void {
    this.bridge.postToHost({
      t: type,
      rid: request.requestId,
      ctx: wireTerminalContext(request.context),
    });
  }

  private handleInbound(message: InboundMessage): void {
    if (this.destroyed) return;
    switch (message.t) {
      case "agent-projects":
        this.handleProjects(message as WireProjectsPush);
        break;
      case "agent-projects-error":
        this.handleProjectsError(message as WireProjectsError);
        break;
      case "agent-project-sessions":
        this.handleProjectSessions(message as WireProjectSessionsPush);
        break;
      case "agent-project-sessions-error":
        this.handleProjectSessionsError(
          message as WireProjectSessionsError,
        );
        break;
      case "agent-thread-chunk":
        this.handleThreadChunk(message as WireThreadChunk);
        break;
      case "agent-thread-error":
        this.handleThreadError(message as WireThreadError);
        break;
      case "agent-raw-event":
      case "agent-raw-event-error":
        this.handleRawEvent(message as WireRawEvent | WireRawEventError);
        break;
      case "agent-command-receipt":
      case "agent-command-error":
        this.handleCommand(message as WireCommandReceipt | WireCommandError);
        break;
      case "agent-extension-ui-request":
        this.handleExtensionUI(message as WireExtensionUIRequest);
        break;
      case "agent-extension-ui-dismissed":
        this.handleExtensionUIDismissed(message as WireExtensionUIDismissed);
        break;
      case "agent-terminal-ready":
      case "agent-terminal-error":
      case "agent-terminal-ended":
        this.handleTerminalStatus(message);
        break;
    }
  }

  private handleProjects(message: WireProjectsPush): void {
    const watch = this.projectWatches.get(message.sub);
    if (!watch) return;
    watch.onSnapshot(
      message.p.map((project) => ({
        projectPath: project.pp,
        displayName: project.dn,
        sourceCounts: {
          ...project.sc,
        },
        sessionCount: project.sn,
        lastEventAt: project.lea,
      })),
    );
  }

  private handleProjectsError(message: WireProjectsError): void {
    this.projectWatches.get(message.sub)?.onError?.(message.r);
  }

  private handleProjectSessions(message: WireProjectSessionsPush): void {
    const watch = this.projectSessionsWatches.get(message.sub);
    if (!watch || watch.projectPath !== message.pp) return;
    watch.onSnapshot(
      message.ss.map(mapSession),
    );
  }

  private handleProjectSessionsError(
    message: WireProjectSessionsError,
  ): void {
    const watch = this.projectSessionsWatches.get(message.sub);
    if (!watch || watch.projectPath !== message.pp) return;
    watch.onError?.(message.r);
  }

  private handleThreadChunk(chunk: WireThreadChunk): void {
    const session: SessionReference = {
      source: chunk.src,
      sessionId: chunk.sid,
      mode: chunk.md ?? "raw",
    };
    const key = sessionKey(session);
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    // A chunk for the view we just left. Its indices are counted in that view, so
    // merging it would shift every row by however many lines the other mode omits
    // before them -- and nothing would report an error. An absent `md` means raw, the
    // rule this field follows at every boundary.
    if ((chunk.md ?? "raw") !== buffer.mode) return;
    if (chunk.seq < buffer.sequence) return;
    buffer.sequence = chunk.seq;
    buffer.runState = chunk.rs ?? buffer.runState;
    buffer.queue = { steer: chunk.qs, followUp: chunk.qf };
    for (const listener of this.liveListeners.get(key) ?? []) {
      listener.onState?.({
        sequence: buffer.sequence,
        runState: buffer.runState,
        queue: buffer.queue,
      });
    }

    const events = chunk.ev.map(mapEvent);
    const previousEvents = new Map(buffer.events);
    if (chunk.k === "snapshot") buffer.events.clear();
    const changedEvents: ActivityEvent[] = [];
    for (const event of events) {
      const current = previousEvents.get(event.index);
      if (!current || (event.revision ?? 0) > (current.revision ?? 0)) {
        buffer.events.set(event.index, event);
        changedEvents.push(event);
      } else if (chunk.k === "snapshot") {
        buffer.events.set(event.index, current);
      }
    }
    buffer.total = chunk.k === "snapshot" ? chunk.tot : Math.max(buffer.total, chunk.tot);
    buffer.windowStart = buffer.seeded
      ? Math.min(buffer.windowStart, chunk.ws)
      : chunk.ws;

    // Announced on every chunk that carries it, live or not, and before the
    // seed/older branching below returns. The seed page reads it off the buffer;
    // a subscriber that is already listening gets it pushed. A chunk with no
    // usage leaves the last value alone rather than clearing it -- the transcript
    // publishes occupancy only on some lines.
    const usage = mapUsage(chunk.u);
    if (usage) {
      buffer.usage = usage;
      for (const listener of this.liveListeners.get(key) ?? []) {
        listener.onUsage?.(usage);
      }
    }

    if (!chunk.lv) {
      if (this.reconnectingThreads.has(key) && buffer.seeded) {
        this.reconnectingThreads.delete(key);
        for (const listener of this.liveListeners.get(key) ?? []) {
          for (const event of changedEvents) listener.onEvent(event);
        }
        return;
      }
      this.reconnectingThreads.delete(key);
      if (!buffer.seeded) {
        buffer.seeded = true;
        const waiters = this.seedWaiters.get(key) ?? [];
        this.seedWaiters.delete(key);
        for (const waiter of waiters) waiter.resolve(buffer);
      } else {
        const beforeIndex = chunk.ws + chunk.ev.length;
        const waiterKey = `${key}:${beforeIndex}`;
        const waiters = this.olderWaiters.get(waiterKey) ?? [];
        this.olderWaiters.delete(waiterKey);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(chunk);
        }
      }
      return;
    }

    if (!buffer.seeded) {
      buffer.seeded = true;
      const waiters = this.seedWaiters.get(key) ?? [];
      this.seedWaiters.delete(key);
      for (const waiter of waiters) waiter.resolve(buffer);
    }
    for (const listener of this.liveListeners.get(key) ?? []) {
      for (const event of changedEvents) listener.onEvent(event);
    }
  }

  private handleThreadError(message: WireThreadError): void {
    const key = sessionKey({
      source: message.src,
      sessionId: message.sid,
      mode: "raw",
    });
    this.reconnectingThreads.delete(key);
    for (const listener of this.liveListeners.get(key) ?? []) {
      listener.onError?.();
    }
    this.rejectSessionWaiters(
      key,
      new Error(`agent-thread-error: ${message.r}`),
    );
  }

  private handleRawEvent(message: WireRawEvent | WireRawEventError): void {
    const waiter = this.rawEventWaiters.get(message.rid);
    if (!waiter) return;
    // The mode is irrelevant to matching: `sessionKey` ignores it, and the reply is
    // already pinned by a request id unique to one request in one mode.
    const expected: SessionReference = {
      source: message.src,
      sessionId: message.sid,
      mode: "raw",
    };
    if (
      waiter.sessionKey !== sessionKey(expected) ||
      waiter.eventIndex !== message.ei
    ) {
      return;
    }
    this.rawEventWaiters.delete(message.rid);
    clearTimeout(waiter.timer);
    if (message.t === "agent-raw-event-error") {
      waiter.reject(new Error(message.r));
    } else {
      waiter.resolve(message.tx);
    }
  }

  private handleCommand(message: WireCommandReceipt | WireCommandError): void {
    const waiter = this.commandWaiters.get(message.rid);
    if (!waiter) return;
    this.commandWaiters.delete(message.rid);
    clearTimeout(waiter.timer);
    if (message.t === "agent-command-error") {
      waiter.reject(new Error(`${message.c}: ${message.m}`));
    } else {
      waiter.resolve({
        requestId: message.rid,
        source: message.src,
        sessionId: message.sid,
        delivery: message.del,
        ...(message.s ? { session: mapSession(message.s) } : {}),
      });
    }
  }

  private handleExtensionUI(message: WireExtensionUIRequest): void {
    const request: AgentExtensionUIRequest = {
      source: message.src,
      sessionId: message.sid,
      requestId: message.rid,
      kind: message.k,
      title: message.ttl,
      message: message.m,
      options: message.o,
      placeholder: message.ph,
      prefill: message.pf,
      level: message.lv,
      key: message.key,
      lines: message.ln,
      expectsResponse: message.er,
    };
    for (const listener of this.extensionUIListeners) {
      listener({ type: "request", request });
    }
  }

  private handleExtensionUIDismissed(message: WireExtensionUIDismissed): void {
    for (const listener of this.extensionUIListeners) {
      listener({
        type: "dismiss",
        source: message.src,
        sessionId: message.sid,
        requestId: message.rid,
      });
    }
  }

  private handleTerminalStatus(message: InboundMessage): void {
    const value = message as Record<string, unknown>;
    const requestId = value.rid;
    const context = mapTerminalContext(value.ctx);
    if (typeof requestId !== "string" || requestId.length === 0 || !context) {
      return;
    }

    let status: AgentTerminalStatus;
    if (value.t === "agent-terminal-ready") {
      if (typeof value.psn !== "string" || value.psn.length === 0) return;
      status = {
        kind: "ready",
        requestId,
        context,
        ptySessionName: value.psn,
      };
    } else if (value.t === "agent-terminal-error") {
      if (typeof value.c !== "string" || value.c.length === 0) return;
      status = { kind: "error", requestId, context, code: value.c };
    } else if (value.t === "agent-terminal-ended") {
      if (typeof value.psn !== "string" || value.psn.length === 0) return;
      if (value.xs !== undefined && typeof value.xs !== "number") return;
      status = {
        kind: "ended",
        requestId,
        context,
        ptySessionName: value.psn,
        exitStatus: value.xs as number | undefined,
      };
    } else {
      return;
    }
    for (const listener of this.terminalStatusListeners) listener(status);
  }

  private fetchOlderPage(
    session: SessionReference,
    beforeIndex: number,
    limit: number,
  ): Promise<EventsPage> {
    const key = sessionKey(session);
    this.bridge.postToHost({
      t: "agent-thread-older",
      src: session.source,
      sid: session.sessionId,
      bi: beforeIndex,
      lim: limit,
      md: session.mode,
    });
    const waiterKey = `${key}:${beforeIndex}`;
    return new Promise<EventsPage>((resolve, reject) => {
      const waiter: OlderWaiter = {
        sessionKey: key,
        reject,
        resolve: (chunk) => {
          const buffer = this.buffers.get(key);
          resolve(
            this.pageFromBuffer(
              buffer ?? {
                events: new Map(),
                total: chunk.tot,
                windowStart: chunk.ws,
                usage: mapUsage(chunk.u),
                mode: chunk.md ?? "raw",
                seeded: true,
                sequence: chunk.seq,
                runState: chunk.rs ?? "idle",
                queue: { steer: chunk.qs, followUp: chunk.qf },
              },
              chunk.ws,
              chunk.ev.length,
            ),
          );
        },
        timer: setTimeout(() => {
          this.rejectOlderWaiters(
            (candidate) => candidate === waiter,
            new Error(
              `agent-thread-older timed out for ${key} before ${beforeIndex}`,
            ),
          );
        }, this.olderPageTimeoutMs),
      };
      const waiters = this.olderWaiters.get(waiterKey) ?? [];
      waiters.push(waiter);
      this.olderWaiters.set(waiterKey, waiters);
    });
  }

  private pageFromBuffer(
    buffer: SessionBuffer,
    offset: number,
    limit: number,
  ): EventsPage {
    const events = Array.from(buffer.events.values())
      .filter(
        (event) =>
          event.index >= offset && event.index < offset + limit,
      )
      .sort((left, right) => left.index - right.index);
    return { events, total: buffer.total, usage: buffer.usage };
  }

  private rejectSessionWaiters(key: string, error: Error): void {
    const seed = this.seedWaiters.get(key) ?? [];
    this.seedWaiters.delete(key);
    for (const waiter of seed) waiter.reject(error);
    this.rejectOlderWaiters(
      (waiter) => waiter.sessionKey === key,
      error,
    );
  }

  private rejectOlderWaiters(
    predicate: (waiter: OlderWaiter) => boolean,
    error: Error,
  ): void {
    for (const [key, waiters] of this.olderWaiters) {
      const remaining: OlderWaiter[] = [];
      for (const waiter of waiters) {
        if (predicate(waiter)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        } else {
          remaining.push(waiter);
        }
      }
      if (remaining.length === 0) this.olderWaiters.delete(key);
      else this.olderWaiters.set(key, remaining);
    }
  }

  destroy(): void {
    if (this.destroyed) return;

    for (const subscriptionId of this.projectWatches.keys()) {
      this.bridge.postToHost({
        t: "agent-projects-unwatch",
        sub: subscriptionId,
      });
    }
    for (const subscriptionId of this.projectSessionsWatches.keys()) {
      this.bridge.postToHost({
        t: "agent-project-sessions-unwatch",
        sub: subscriptionId,
      });
    }
    for (const session of this.activeThreads.values()) {
      this.bridge.postToHost({
        t: "agent-thread-unsub",
        src: session.source,
        sid: session.sessionId,
      });
    }
    this.endActiveTerminalContext();
    this.destroyed = true;
    this.unsubscribeHostMessages?.();
    this.unsubscribeHostMessages = null;

    const error = new Error("BridgeDataSource destroyed");
    for (const key of this.seedWaiters.keys()) {
      this.rejectSessionWaiters(key, error);
    }
    for (const waiter of this.rawEventWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.rawEventWaiters.clear();
    for (const waiter of this.commandWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.commandWaiters.clear();
    this.projectWatches.clear();
    this.projectSessionsWatches.clear();
    this.activeThreads.clear();
    this.reconnectingThreads.clear();
    this.buffers.clear();
    this.liveListeners.clear();
    this.terminalStatusListeners.clear();
    this.extensionUIListeners.clear();
    this.activeTerminalRequest = null;
  }
}
