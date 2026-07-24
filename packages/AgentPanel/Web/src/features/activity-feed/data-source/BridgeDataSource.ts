import type { ActivityBlock, ActivityEvent } from "../useSessionEventsStream";
import { normalizeActivityEvent } from "../activityNormalization";
import type {
  AgentDataSource,
  AgentSource,
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
}

interface WireActivityEvent {
  i: number;
  ts: number;
  tp: string;
  b: WireActivityBlock[];
}

interface WireProjectSummary {
  pp: string;
  dn: string;
  sc: { cl: number; co: number };
  sn: number;
  lea: number;
}

interface WireSessionSummary {
  sid: string;
  src: AgentSource;
  ttl: string;
  lea: number;
  ac: SessionActivity;
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

interface WireThreadChunk {
  t: "agent-thread-chunk";
  src: AgentSource;
  sid: string;
  ev: WireActivityEvent[];
  ws: number;
  tot: number;
  lv: boolean;
}

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

type InboundMessage =
  | WireProjectsPush
  | WireProjectsError
  | WireProjectSessionsPush
  | WireProjectSessionsError
  | WireThreadChunk
  | WireThreadError
  | WireRawEvent
  | WireRawEventError
  | { t: string };

export type SessionActivity = "live" | "ready" | "paused" | "cold";

export interface BridgeProject {
  projectPath: string;
  displayName: string;
  sourceCounts: { claude: number; codex: number };
  sessionCount: number;
  lastEventAt: number;
}

export interface BridgeSessionSummary {
  sessionId: string;
  source: AgentSource;
  title: string;
  lastEventAt: number;
  activity: SessionActivity;
}

export interface AgentTerminalContext {
  projectPath: string;
  source: AgentSource;
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
  seeded: boolean;
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
  };
}

function mapEvent(wire: WireActivityEvent): ActivityEvent {
  return normalizeActivityEvent({
    index: wire.i,
    ts: wire.ts,
    type: wire.tp,
    blocks: wire.b.map(mapBlock),
  });
}

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
      });
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
      seeded: false,
    });
    this.bridge.postToHost({
      t: "agent-thread-sub",
      src: session.source,
      sid: session.sessionId,
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
          claude: project.sc.cl,
          codex: project.sc.co,
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
      message.ss.map((session) => ({
        sessionId: session.sid,
        source: session.src,
        title: session.ttl,
        lastEventAt: session.lea,
        activity: session.ac,
      })),
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
    };
    const key = sessionKey(session);
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    const previousTotal = buffer.total;
    const events = chunk.ev.map(mapEvent);
    for (const event of events) buffer.events.set(event.index, event);
    buffer.total = Math.max(buffer.total, chunk.tot);
    buffer.windowStart = buffer.seeded
      ? Math.min(buffer.windowStart, chunk.ws)
      : chunk.ws;

    if (!chunk.lv) {
      if (this.reconnectingThreads.has(key) && buffer.seeded) {
        this.reconnectingThreads.delete(key);
        for (const listener of this.liveListeners.get(key) ?? []) {
          for (const event of events) {
            if (event.index >= previousTotal) listener.onEvent(event);
          }
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
      for (const event of events) listener.onEvent(event);
    }
  }

  private handleThreadError(message: WireThreadError): void {
    const key = sessionKey({
      source: message.src,
      sessionId: message.sid,
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
    const expected = {
      source: message.src,
      sessionId: message.sid,
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
                seeded: true,
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
    return { events, total: buffer.total };
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
    this.projectWatches.clear();
    this.projectSessionsWatches.clear();
    this.activeThreads.clear();
    this.reconnectingThreads.clear();
    this.buffers.clear();
    this.liveListeners.clear();
    this.terminalStatusListeners.clear();
    this.activeTerminalRequest = null;
  }
}
