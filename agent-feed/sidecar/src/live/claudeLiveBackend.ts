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

import { config } from "@/config/config";
import type {
  AgentBackend,
  AgentCommandReceipt,
  AgentSessionDescriptor,
  AgentTimelinePage,
  AgentUiResponseResult,
} from "@/agents/agentBackend";
import { AgentBackendDisposedError, AgentModeUnsupportedError } from "@/agents/agentBackend";
import type { TimelineEnvelope } from "@/agents/liveAgentProjection";
import { LiveSessionRegistry, livePage } from "@/live/liveSessionRegistry";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import type { EventMode, TokenUsage } from "@/transcripts/transcriptTypes";
import { fetchRequestMetadata, type ToolResultItem } from "@/live/claudeRequestBody";
import {
  claudeLiveReconnectDelay,
  decodeDeltaData,
  describeRecordsDropped,
  mapAnthropicStreamEvent,
  requestsLongContext,
  runObserverLoop,
  type AnthropicStreamEvent,
  type ObserverEvent,
  type ObserverFlow,
  type ObserverSubscription,
} from "@/live/claudeNetworkSource";
import { CompactionWatch } from "@/live/claudeCompactionWatch";
import {
  bufferDelta,
  CLAUDE_LIVE_CAPABILITIES,
  flowStartedAtMs,
  flowsLostWithCapture,
  isMessageStream,
  newFlowContext,
  observedAtMs,
  type FlowContext,
} from "@/live/claudeLiveFlows";
import { applyStreamEvent, publishMessage, toolResultBlocks } from "@/live/claudeLiveMessages";

export class ClaudeLiveBackend implements AgentBackend {
  readonly id = "claude";
  readonly capabilities = CLAUDE_LIVE_CAPABILITIES;

  private readonly sessions: LiveSessionRegistry;
  private readonly binds = new Map<string, string>();
  // Sessions whose requests ask for the million-token context, learned from the request's own
  // `anthropic-beta` list. Per session and only ever added to, for the same reason the declared
  // model's tier is sticky: every request of a session carries the same beta list, so a flow that
  // did not name it is a flow this mirror failed to read rather than a session that changed tier.
  // A reader who genuinely moves from 1M down to 200k mid-session keeps the larger window here,
  // which is the cheaper error -- the other way round shows a meter five times too full.
  private readonly longContextSessions = new Set<string>();
  private readonly flowContexts = new Map<string, FlowContext>();
  /** Sessions an SDK runner is streaming (ADR-0143); captured flows for them are dropped, not raced. */
  private readonly runnerFed = new Set<string>();
  private readonly compactions = new CompactionWatch();
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

  private runLoop(): Promise<void> {
    return runObserverLoop({
      vendor: "claude",
      endpoint: this.endpoint,
      signal: this.abortController?.signal,
      disposed: () => this.disposed,
      onEvent: (event) => this.acceptObserverEvent(event),
      onError: (error) => {
        this.lastError = error;
      },
      onSubscription: (subscription) => {
        this.subscription = subscription;
      },
      reconnectDelay: claudeLiveReconnectDelay,
      // The observer does not resume a flow it was streaming when the connection dropped, so each
      // open flow ends here or its message stays streaming for good. Measured 2026-10-08: the
      // connection dropped as a message's thinking finished, its reply never arrived, and the row
      // sat streaming under a turn the transcript had long finished.
      onConnectionEnded: () => {
        for (const flowId of [...this.flowContexts.keys()]) this.acceptStreamEnded(flowId);
      },
    });
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

  async page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage> {
    this.assertActive();
    if (mode !== "nice" && mode !== "raw") {
      throw new AgentModeUnsupportedError("claude live supports raw and nice only");
    }
    return livePage(this.sessions.require(sessionId), offset, limit, mode);
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
    this.longContextSessions.clear();
    this.flowContexts.clear();
    this.runnerFed.clear();
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
    // The observer's capture pipeline fell behind and threw records away. Said out loud because it
    // is the one cause of a live message stopping mid-sentence this process cannot otherwise see,
    // and because it is not ours to fix from here.
    if (event.recordsDropped) console.warn(describeRecordsDropped(event.recordsDropped));
    // A capture that died takes its open flows with it, and nothing else will ever end them.
    const lost = event.captureHealthChanged?.health
      ? flowsLostWithCapture(this.flowContexts, event.captureHealthChanged.health)
      : null;
    if (lost) {
      if (lost.line) console.warn(lost.line);
      for (const flowId of lost.flowIds) this.acceptStreamEnded(flowId);
    }
  }

  private acceptFlowUpserted(flow: ObserverFlow, ts: number): void {
    const flowId = flow.flowId;
    if (typeof flowId !== "string" || !flowId) return;
    if (this.binds.has(flowId)) return;
    if (!isMessageStream(flow)) return;
    const context = this.flowContexts.get(flowId) ?? newFlowContext();
    this.flowContexts.set(flowId, context);
    if (typeof flow.sourceId === "string" && flow.sourceId) context.sourceId = flow.sourceId;
    if (context.binding) return;
    const reference = flow.requestBody?.value;
    if (typeof reference !== "string" || reference.length === 0) {
      // The observer announces one flow more than once and does not always have the body retained
      // by the first announcement. Wait for the announcement that carries it. Dropping here is what
      // this used to do, and the later announcement was then refused for having a context already,
      // so a bind that was one event away never happened and the turn went unmirrored.
      return;
    }
    // Read now rather than at bind time: the session id arrives from an async body fetch, and the
    // headers are on the flow in hand.
    const longContext = requestsLongContext(flow.requestHeaders);
    context.binding = true;
    void fetchRequestMetadata(this.endpoint, reference)
      .then(({ sessionId, toolResults, subagent, conversationTurn, compaction }) => {
        context.binding = false;
        if (this.disposed) return;
        // Read before the context check below, because saying a session is compacting does not
        // need one. A flow buffers deltas while its body is being fetched and the buffer is
        // capped; a summariser streaming a large summary overruns it, the flow is dropped, and
        // this callback then returned before reporting the one thing it still could. Measured on
        // one probe session compacted twice: announced on the first run, silent on the second.
        //
        // Safe to call without knowing whether the stream is still open, because the watch refuses
        // a flow whose end has already been seen, and the end is recorded whether or not the flow
        // was ever recognised.
        if (sessionId && !conversationTurn && compaction) {
          this.compactions.begin(
            flowId,
            sessionId,
            context.pending.map((item) => item.payload),
          );
        }
        if (!this.flowContexts.has(flowId)) return;
        // A subagent's request carries its PARENT's session id, so binding it would mirror the
        // subagent's whole answer into the parent's live view -- text the parent never said,
        // streaming in while the parent sits blocked on the tool call that started it. Dropped
        // rather than mirrored somewhere else: there is no live surface for a subagent to belong
        // to, and its lines still reach the panel the durable way, through the transcript the
        // harness writes at `<session>/subagents/agent-<id>.jsonl` and the route that serves it.
        //
        // The harness's own errands go the same way: a composer suggestion and a compaction
        // summariser are not the session speaking. A summariser's text goes to the watch above
        // instead, which keeps it beside the thread rather than on top of its compaction banner.
        if (!sessionId || subagent || !conversationTurn || this.runnerFed.has(sessionId)) {
          this.scheduleFlowDrop(flowId);
          return;
        }
        if (longContext) this.longContextSessions.add(sessionId);
        // Dated by the flow, not by the event: on a fresh subscription the observer replays
        // finished flows with `observedAt` restamped to now, and the panel resolves live against
        // durable by whichever is newer. See `flowStartedAtMs`.
        this.bindFlow(flowId, sessionId, toolResults, flowStartedAtMs(flow, ts));
      })
      .catch((error) => {
        context.binding = false;
        if (!this.disposed) this.lastError = error;
        this.scheduleFlowDrop(flowId);
      });
  }

  /**
   * One frame of an SDK runner's message (ADR-0143), the session's own account of it; a null
   * payload ends the message. Released when the runner goes, leaving the capture as the account.
   */
  acceptRunnerStream(sessionId: string, flowId: string, payload: string | null, ts: number): void {
    if (this.disposed) return;
    this.runnerFed.add(sessionId);
    if (payload === null) return this.acceptStreamEnded(flowId);
    if (!this.binds.has(flowId)) this.bindFlow(flowId, sessionId, [], ts, newFlowContext());
    this.applyPayload(sessionId, flowId, payload, ts);
  }

  releaseRunnerStream(sessionId: string): void {
    this.runnerFed.delete(sessionId);
  }

  private acceptDelta(delta: { flowId?: unknown; data?: unknown }, ts: number): void {
    if (typeof delta.flowId !== "string" || typeof delta.data !== "string") return;
    const payload = decodeDeltaData(delta.data);
    // A running compaction's summary is kept beside the thread, never bound into it.
    if (this.compactions.append(delta.flowId, payload)) return;
    const sessionId = this.binds.get(delta.flowId);
    if (sessionId !== undefined) {
      this.applyPayload(sessionId, delta.flowId, payload, ts);
      return;
    }
    const context = this.flowContexts.get(delta.flowId);
    if (!context) return;
    bufferDelta(context, payload, ts);
  }

  private acceptStreamEnded(flowId: unknown): void {
    if (typeof flowId !== "string") return;
    this.compactions.end(flowId);
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
    if (!context) return;
    context.ended = true;
    // Nothing is coming to flush it: only a body fetch can bind a flow, and none is running.
    if (!context.binding) this.dropFlow(flowId);
  }

  /** `startedMs` is when the request was sent, not when its flow was announced. */
  private bindFlow(
    flowId: string,
    sessionId: string,
    toolResults: ToolResultItem[],
    startedMs: number,
    created?: FlowContext,
  ): void {
    if (created) this.flowContexts.set(flowId, created);
    const context = this.flowContexts.get(flowId);
    if (!context) return;
    this.binds.set(flowId, sessionId);
    this.sessions.ensure(sessionId);
    context.sessionId = sessionId;
    // The request body carries this turn's user message, which is where a
    // previous assistant turn's tool results land. Publish them before the
    // response deltas so the conversation reads in order: tool result, then the
    // assistant's continuation.
    if (toolResults.length > 0) this.publishToolResults(sessionId, flowId, toolResults, startedMs);
    const pending = context.pending;
    context.pending = [];
    context.pendingBytes = 0;
    if (context.lost > 0) {
      console.warn(
        `agent-feed-claude-live-flow-buffer-overrun: flow=${flowId} session=${sessionId} lost=${context.lost}`,
      );
    }
    for (const item of pending) this.applyPayload(sessionId, flowId, item.payload, item.ts);
    if (context.ended) {
      // A flow ended by a dropped connection carries no `message_stop` to finish its message.
      this.finishMessage(sessionId, flowId);
      this.dropFlow(flowId);
      this.sessions.scheduleDrop(sessionId);
    }
  }

  private publishToolResults(sessionId: string, flowId: string, results: ToolResultItem[], ts: number): void {
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
      const created = newFlowContext(sessionId);
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
      this.longContextSessions.has(sessionId),
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

  /**
   * A session's compaction: whether one is running, and the summary it has written so far. Probed
   * rather than required by their one caller, like `onSessionLive`: only Claude's harness compacts.
   */
  onCompaction(listener: (sessionId: string, active: boolean) => void): () => void {
    return this.compactions.onChange(listener);
  }

  /** Null when the session is not compacting. See `CompactionWatch`. */
  compactionSummary(sessionId: string): string | null {
    return this.compactions.summary(sessionId);
  }

  onCompactionSummary(listener: (sessionId: string, text: string, replace: boolean) => void): () => void {
    return this.compactions.onSummary(listener);
  }

  private scheduleFlowDrop(flowId: string): void {
    const timer = setTimeout(() => {
      // A later announcement of the same flow may have bound it since. Dropping a bound flow is
      // exactly how a live message stops mid-sentence and never completes.
      if (this.binds.has(flowId)) return;
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
