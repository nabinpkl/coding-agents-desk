// Read-only codex live backend: mirrors what Codex Desktop actually does by
// observing its real `/backend-api/codex/responses` WebSocket traffic through
// proxy-agent, and exposes it through the same `AgentBackend` surface Pi and
// the claude live mirror use -- except it can never send, steer, or abort. The
// durable codex transcript path (the state sqlite) stays the durable history;
// this is a complementary live mirror that coexists with it.
//
// Ingest: one proxy-observer SSE subscription (filtered to chatgpt.com
// WebSocket flows) is mapped into per-session `LiveAgentProjection`s, keyed by
// the `session-id` carried in each captured flow's request headers -- the same
// id agent-feed keys codex threads by, which is what makes the mirror land on
// the right row.

import { config } from "@/config";
import type {
  AgentBackend,
  AgentCommandReceipt,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentTimelinePage,
  AgentUiEvent,
  AgentUiResponseResult,
} from "@/agents/agentBackend";
import {
  AgentBackendDisposedError,
  AgentModeUnsupportedError,
} from "@/agents/agentBackend";
import type { TimelineEnvelope } from "@/agents/liveAgentProjection";
import { LiveSessionRegistry } from "@/live/liveSessionRegistry";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import type { EventMode, TokenUsage } from "@/transcripts/transcriptTypes";
import {
  CODECX_OBSERVER_FILTER,
  decodeWebSocketMessage,
  extractCodexSessionId,
  mapCodexMessage,
  type CodexMessageEvent,
  type ObservedRequestHeader,
} from "@/live/codexNetworkSource";
import { isCodexStream, observedAtMs, type FlowContext } from "@/live/codexLiveFlows";
import { CodexItemStore } from "@/live/codexLiveItems";
import { applyCodexEvent, finishStreaming } from "@/live/codexLiveEvents";
import type { ObserverEvent, ObserverSubscription } from "@/live/claudeNetworkSource";
import { subscribeToObserver } from "@/live/claudeNetworkSource";

export const CODECX_LIVE_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: false,
  canOpenTerminal: false,
  supportsExtensionUi: false,
  canStreamLive: true,
};

export class CodexLiveBackend implements AgentBackend {
  readonly id = "codex";
  readonly capabilities = CODECX_LIVE_CAPABILITIES;

  private readonly sessions: LiveSessionRegistry;
  private readonly items: CodexItemStore;
  private readonly binds = new Map<string, string>();
  private readonly flowContexts = new Map<string, FlowContext>();
  private subscription: ObserverSubscription | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private lastError: unknown = null;

  constructor(
    private readonly endpoint: URL = config.proxyObserverEndpoint,
    private readonly enabled: boolean = config.codexLiveEnabled,
    maxSessions: number = config.codexLiveMaxSessions,
  ) {
    this.sessions = new LiveSessionRegistry({
      vendor: "codex",
      maxSessions,
      idleDropMs: config.codexLiveIdleDropMs,
      forget: (sessionId) => this.items.forget(sessionId),
    });
    this.items = new CodexItemStore((sessionId) => this.sessions.require(sessionId));
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.enabled) {
      console.log("agent-feed-codex-live: disabled");
      return;
    }
    if (this.subscription !== null || this.abortController !== null) return;
    this.abortController = new AbortController();
    console.log("agent-feed-codex-live: starting observer subscription");
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.disposed) {
      try {
        const subscription = await subscribeToObserver(
          this.endpoint,
          (event) => this.acceptObserverEvent(event),
          (error) => {
            this.lastError = error;
            if (!this.disposed) {
              console.error(`agent-feed-codex-live-observer-error: ${String(error)}`);
            }
          },
          this.abortController?.signal,
          CODECX_OBSERVER_FILTER,
        );
        this.subscription = subscription;
        attempt = 0;
        await subscription.closed;
        if (!this.disposed) {
          console.log("agent-feed-codex-live-observer-stream-ended");
        }
      } catch (error) {
        if (!this.disposed) this.lastError = error;
        if (!this.disposed) {
          console.error(`agent-feed-codex-live-observer-connect-failed: ${String(error)}`);
        }
      }
      if (this.disposed) break;
      const delay = codexLiveReconnectDelay(attempt++);
      if (!this.disposed) {
        console.log(`agent-feed-codex-live: reconnecting in ${delay}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  lastIngestError(): unknown {
    return this.lastError;
  }

  describeSession(sessionId: string): AgentSessionDescriptor | undefined {
    if (this.disposed) return undefined;
    const catalogSession = findSession("codex", sessionId);
    if (!catalogSession) return undefined;
    // A codex desktop session is live-capable whenever it exists in the catalog:
    // its response socket stays open for the whole app session, so the mirror
    // can always attach. The projection appears lazily on the first event or
    // subscription, which is why no projection is required to describe it.
    const projection = this.sessions.get(sessionId);
    return {
      sessionId,
      source: "codex",
      projectPath: catalogSession.project,
      title: catalogSession.title ?? sessionId,
      lastEventAt: this.sessions.lastEventAt(sessionId),
      activity: projection?.runState === "running" ? "live" : "ready",
      capabilities: this.capabilities,
    };
  }

  async createSession(): Promise<AgentSessionDescriptor> {
    throw new AgentModeUnsupportedError("codex live sessions are read-only");
  }

  async page(
    sessionId: string,
    offset: number,
    limit: number,
    mode: EventMode,
  ): Promise<AgentTimelinePage> {
    this.assertActive();
    if (mode !== "nice" && mode !== "raw") {
      throw new AgentModeUnsupportedError("codex live supports raw and nice only");
    }
    // A viewer may page a session before its first event: the mirror attaches
    // to any catalog session on demand, so an empty page beats a 404.
    const projection = this.sessions.ensure(sessionId);
    const sequence = projection.snapshot().sequence;
    return {
      // A live stream has no machinery lines, so raw and nice are the same set;
      // the index is insertion order in both. otherModeIndex = index makes a
      // mode toggle a no-op instead of an empty cross-reference.
      events: projection.page(offset, limit).map((event) => ({ ...event, otherModeIndex: event.index })),
      total: projection.total,
      mode,
      sequence,
      runState: projection.runState,
      queue: projection.queue,
    };
  }

  async subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (envelope: TimelineEnvelope) => void,
  ): Promise<() => void> {
    this.assertActive();
    // The host opens the tail the moment a thread is viewed, which can precede
    // any captured traffic; create the projection so the subscription is a
    // live attachment point rather than a 404.
    const projection = this.sessions.ensure(sessionId);
    this.sessions.retain(sessionId);
    const unsubscribe = projection.subscribe(afterSequence, listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      this.sessions.release(sessionId);
    };
  }

  async send(): Promise<AgentCommandReceipt> {
    throw new AgentModeUnsupportedError("codex live sessions are read-only");
  }

  async abort(): Promise<AgentCommandReceipt> {
    throw new AgentModeUnsupportedError("codex live sessions are read-only");
  }

  async subscribeUi(): Promise<() => void> {
    return () => {};
  }

  async respondToUi(): Promise<AgentUiResponseResult> {
    throw new AgentModeUnsupportedError("codex live sessions have no extension UI");
  }

  sessionUsage(sessionId: string): TokenUsage | null {
    return this.sessions.usage.get(sessionId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.subscription?.close();
    this.subscription = null;
    this.sessions.clear();
    this.binds.clear();
    this.flowContexts.clear();
  }

  // --- ingest ---------------------------------------------------------------

  acceptObserverEvent(event: ObserverEvent): void {
    if (this.disposed) return;
    const ts = observedAtMs(event);
    if (event.flowUpserted?.flow) {
      this.acceptFlowUpserted(event.flowUpserted.flow);
    }
    if (event.websocketMessageObserved) {
      this.acceptMessage(event.websocketMessageObserved, ts);
    }
    if (event.streamEnded) {
      this.acceptStreamEnded(event.streamEnded.flowId);
    }
  }

  private acceptFlowUpserted(flow: {
    flowId?: unknown;
    authority?: unknown;
    path?: unknown;
    protocol?: unknown;
    requestHeaders?: unknown;
  }): void {
    const flowId = flow.flowId;
    if (typeof flowId !== "string" || !flowId) return;
    if (this.binds.has(flowId) || this.flowContexts.has(flowId)) return;
    if (!isCodexStream(flow)) return;
    // The codex session id rides in the request headers, so binding is
    // synchronous -- no body fetch round trip like the claude mirror needs.
    const sessionId = extractCodexSessionId(flow.requestHeaders);
    if (!sessionId) {
      this.scheduleFlowDrop(flowId);
      return;
    }
    this.binds.set(flowId, sessionId);
    this.sessions.ensure(sessionId);
    this.flowContexts.set(flowId, { sessionId, streaming: new Set(), ended: false });
  }

  private acceptMessage(
    message: { flowId?: unknown; data?: unknown },
    ts: number,
  ): void {
    if (typeof message.flowId !== "string" || typeof message.data !== "string") return;
    const sessionId = this.binds.get(message.flowId);
    if (sessionId === undefined) return;
    const payload = decodeWebSocketMessage(message.data);
    this.applyPayload(sessionId, message.flowId, payload, ts);
  }

  private acceptStreamEnded(flowId: unknown): void {
    if (typeof flowId !== "string") return;
    const context = this.flowContexts.get(flowId);
    if (!context) return;
    finishStreaming(this.items, context);
    this.sessions.scheduleDrop(context.sessionId);
    this.dropFlow(flowId);
  }

  private applyPayload(sessionId: string, flowId: string, payload: string, ts: number): void {
    this.sessions.touch(sessionId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const event = mapCodexMessage(parsed);
    if (event === null) return;
    const context = this.flowContexts.get(flowId);
    if (!context) return;
    this.applyEvent(sessionId, context, event, ts);
  }

  private applyEvent(
    sessionId: string,
    context: FlowContext,
    event: CodexMessageEvent,
    ts: number,
  ): void {
    applyCodexEvent(
      this.sessions.ensure(sessionId),
      this.items,
      this.sessions.usage,
      sessionId,
      context,
      event,
      ts,
    );
  }

  /** See `LiveSessionRegistry.onSessionLive`. */
  onSessionLive(listener: (sessionId: string) => void): () => void {
    return this.sessions.onSessionLive(listener);
  }

  private scheduleFlowDrop(flowId: string): void {
    const timer = setTimeout(() => {
      this.dropFlow(flowId);
    }, 5_000);
    timer.unref?.();
  }

  private dropFlow(flowId: string): void {
    this.binds.delete(flowId);
    this.flowContexts.delete(flowId);
  }

  private assertActive(): void {
    if (this.disposed) throw new AgentBackendDisposedError("codex live backend is disposed");
  }
}

export function codexLiveReconnectDelay(attempt: number): number {
  const exponent = Math.min(attempt, 10);
  const delay = config.codexLiveReconnectMs * 2 ** exponent;
  return Math.min(delay, config.codexLiveReconnectMaxMs);
}
