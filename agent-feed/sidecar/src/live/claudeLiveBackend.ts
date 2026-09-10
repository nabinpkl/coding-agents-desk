// Read-only claude live backend: mirrors what the frontier harness (Claude Code)
// actually does by observing its real `/v1/messages` traffic through proxy-agent,
// and exposes it through the same `AgentBackend` surface Pi uses -- except it can
// never send, steer, or abort. The transcript path stays the durable history; this
// is a complementary live mirror that coexists with it.
//
// Ingest: one proxy-observer SSE subscription (filtered to Anthropic message
// streams) is mapped into per-session `LiveAgentProjection`s, keyed by the
// `session_id` carried in each captured request body -- the same id agent-feed
// keys claude sessions by, which is what makes the mirror land on the right row.

import { config } from "@/config";
import type {
  AgentBackend,
  AgentCommandReceipt,
  AgentMessageDelivery,
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
  claudeLiveReconnectDelay,
  decodeDeltaData,
  fetchRequestMetadata,
  mapAnthropicStreamEvent,
  subscribeToObserver,
  type AnthropicStreamEvent,
  type ObserverEvent,
  type ObserverSubscription,
  type ToolResultItem,
} from "@/live/claudeNetworkSource";
import {
  isMessageStream,
  observedAtMs,
  MAX_PENDING_PER_FLOW,
  type FlowContext,
} from "@/live/claudeLiveFlows";
import { applyStreamEvent, publishMessage, toolResultBlocks } from "@/live/claudeLiveMessages";

export const CLAUDE_LIVE_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: false,
  canOpenTerminal: false,
  supportsExtensionUi: false,
  canStreamLive: true,
};

export class ClaudeLiveBackend implements AgentBackend {
  readonly id = "claude";
  readonly capabilities = CLAUDE_LIVE_CAPABILITIES;

  private readonly sessions: LiveSessionRegistry;
  private readonly binds = new Map<string, string>();
  private readonly flowContexts = new Map<string, FlowContext>();
  private subscription: ObserverSubscription | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private lastError: unknown = null;

  constructor(
    private readonly endpoint: URL = config.proxyObserverEndpoint,
    private readonly enabled: boolean = config.claudeLiveEnabled,
    maxSessions: number = config.claudeLiveMaxSessions,
  ) {
    this.sessions = new LiveSessionRegistry({
      vendor: "claude",
      maxSessions,
      idleDropMs: config.claudeLiveIdleDropMs,
    });
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.enabled) {
      console.log("agent-feed-claude-live: disabled");
      return;
    }
    if (this.subscription !== null || this.abortController !== null) return;
    this.abortController = new AbortController();
    console.log("agent-feed-claude-live: starting observer subscription");
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
              console.error(`agent-feed-claude-live-observer-error: ${String(error)}`);
            }
          },
          this.abortController?.signal,
        );
        this.subscription = subscription;
        attempt = 0;
        await subscription.closed;
        if (!this.disposed) {
          console.log("agent-feed-claude-live-observer-stream-ended");
        }
      } catch (error) {
        if (!this.disposed) this.lastError = error;
        if (!this.disposed) {
          console.error(`agent-feed-claude-live-observer-connect-failed: ${String(error)}`);
        }
      }
      if (this.disposed) break;
      const delay = claudeLiveReconnectDelay(attempt++);
      if (!this.disposed) {
        console.log(`agent-feed-claude-live: reconnecting in ${delay}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  lastIngestError(): unknown {
    return this.lastError;
  }

  describeSession(sessionId: string): AgentSessionDescriptor | undefined {
    if (this.disposed) return undefined;
    const projection = this.sessions.get(sessionId);
    if (!projection) return undefined;
    const catalogSession = findSession("claude", sessionId);
    if (!catalogSession) return undefined;
    return {
      sessionId,
      source: "claude",
      projectPath: catalogSession.project,
      title: catalogSession.title ?? sessionId,
      lastEventAt: this.sessions.lastEventAt(sessionId),
      activity: projection.runState === "running" ? "live" : "ready",
      capabilities: this.capabilities,
    };
  }

  async createSession(): Promise<AgentSessionDescriptor> {
    throw new AgentModeUnsupportedError("claude live sessions are read-only");
  }

  async page(
    sessionId: string,
    offset: number,
    limit: number,
    mode: EventMode,
  ): Promise<AgentTimelinePage> {
    this.assertActive();
    if (mode !== "nice" && mode !== "raw") {
      throw new AgentModeUnsupportedError("claude live supports raw and nice only");
    }
    const projection = this.sessions.require(sessionId);
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
    const projection = this.sessions.require(sessionId);
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
    throw new AgentModeUnsupportedError("claude live sessions are read-only");
  }

  async abort(): Promise<AgentCommandReceipt> {
    throw new AgentModeUnsupportedError("claude live sessions are read-only");
  }

  async subscribeUi(): Promise<() => void> {
    return () => {};
  }

  async respondToUi(): Promise<AgentUiResponseResult> {
    throw new AgentModeUnsupportedError("claude live sessions have no extension UI");
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
      this.acceptFlowUpserted(event.flowUpserted.flow, ts);
    }
    if (event.streamDeltaObserved) {
      this.acceptDelta(event.streamDeltaObserved, ts);
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
    requestBody?: { value?: unknown };
  }, ts: number): void {
    const flowId = flow.flowId;
    if (typeof flowId !== "string" || !flowId) return;
    if (this.binds.has(flowId) || this.flowContexts.has(flowId)) return;
    if (!isMessageStream(flow)) return;
    const context: FlowContext = { sessionId: null, message: null, pending: [], ended: false };
    this.flowContexts.set(flowId, context);
    const reference = flow.requestBody?.value;
    if (typeof reference !== "string" || reference.length === 0) {
      this.scheduleFlowDrop(flowId);
      return;
    }
    void fetchRequestMetadata(this.endpoint, reference)
      .then(({ sessionId, toolResults }) => {
        if (this.disposed || !this.flowContexts.has(flowId)) return;
        if (!sessionId) {
          this.scheduleFlowDrop(flowId);
          return;
        }
        this.bindFlow(flowId, sessionId, toolResults, ts);
      })
      .catch((error) => {
        if (!this.disposed) this.lastError = error;
        this.scheduleFlowDrop(flowId);
      });
  }

  private acceptDelta(delta: { flowId?: unknown; data?: unknown }, ts: number): void {
    if (typeof delta.flowId !== "string" || typeof delta.data !== "string") return;
    const payload = decodeDeltaData(delta.data);
    const sessionId = this.binds.get(delta.flowId);
    if (sessionId !== undefined) {
      this.applyPayload(sessionId, delta.flowId, payload, ts);
      return;
    }
    const context = this.flowContexts.get(delta.flowId);
    if (!context) return;
    if (context.pending.length >= MAX_PENDING_PER_FLOW) {
      this.dropFlow(delta.flowId);
      return;
    }
    context.pending.push({ payload, ts });
  }

  private acceptStreamEnded(flowId: unknown): void {
    if (typeof flowId !== "string") return;
    const sessionId = this.binds.get(flowId);
    if (sessionId !== undefined) {
      this.finishMessage(sessionId, flowId);
      this.sessions.scheduleDrop(sessionId);
      this.dropFlow(flowId);
      return;
    }
    // The body bind is still in flight: keep the context so the bind can flush
    // the buffered deltas, and drop once it completes.
    const context = this.flowContexts.get(flowId);
    if (context) context.ended = true;
  }

  private bindFlow(flowId: string, sessionId: string, toolResults: ToolResultItem[], ts: number): void {
    const context = this.flowContexts.get(flowId);
    if (!context) return;
    this.binds.set(flowId, sessionId);
    this.sessions.ensure(sessionId);
    context.sessionId = sessionId;
    // The request body carries this turn's user message, which is where a
    // previous assistant turn's tool results land. Publish them before the
    // response deltas so the conversation reads in order: tool result, then the
    // assistant's continuation.
    if (toolResults.length > 0) this.publishToolResults(sessionId, flowId, toolResults, ts);
    const pending = context.pending;
    context.pending = [];
    for (const item of pending) this.applyPayload(sessionId, flowId, item.payload, item.ts);
    if (context.ended) {
      this.dropFlow(flowId);
      this.sessions.scheduleDrop(sessionId);
    }
  }

  private publishToolResults(
    sessionId: string,
    flowId: string,
    results: ToolResultItem[],
    ts: number,
  ): void {
    const projection = this.sessions.ensure(sessionId);
    const blocks = toolResultBlocks(results);
    projection.upsert({
      id: `claude-live:user:${flowId}`,
      ts,
      type: "user",
      phase: "complete",
      blocks: blocks.map((block) => ({ ...block })),
    });
  }

  private applyPayload(sessionId: string, flowId: string, payload: string, ts: number): void {
    this.sessions.touch(sessionId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const event = mapAnthropicStreamEvent(parsed);
    if (event === null) return;
    const context = this.flowContexts.get(flowId);
    if (!context) {
      const created: FlowContext = { sessionId, message: null, pending: [], ended: false };
      this.flowContexts.set(flowId, created);
      this.applyEvent(sessionId, flowId, created, event, ts);
      return;
    }
    this.applyEvent(sessionId, flowId, context, event, ts);
  }

  private applyEvent(
    sessionId: string,
    flowId: string,
    context: FlowContext,
    event: AnthropicStreamEvent,
    ts: number,
  ): void {
    applyStreamEvent(
      this.sessions.ensure(sessionId),
      this.sessions.usage,
      sessionId,
      flowId,
      context,
      event,
      ts,
    );
  }

  private finishMessage(sessionId: string, flowId: string): void {
    const context = this.flowContexts.get(flowId);
    if (!context?.message) return;
    if (context.message.phase === "streaming") {
      context.message.phase = "complete";
      context.message.toolRaw.clear();
      publishMessage(this.sessions.require(sessionId), context.message);
    }
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
    if (this.disposed) throw new AgentBackendDisposedError("claude live backend is disposed");
  }
}
