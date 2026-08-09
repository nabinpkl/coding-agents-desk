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

import { config, contextWindowFor } from "../config.ts";
import type {
  AgentBackend,
  AgentCommandReceipt,
  AgentMessageDelivery,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentTimelinePage,
  AgentUiEvent,
  AgentUiResponseResult,
} from "../agents/agentBackend.ts";
import {
  AgentBackendDisposedError,
  AgentModeUnsupportedError,
  AgentSessionNotFoundError,
} from "../agents/agentBackend.ts";
import { LiveAgentProjection, type TimelineEnvelope } from "../agents/liveAgentProjection.ts";
import { findSession } from "../transcripts/transcriptCatalog.ts";
import type { ActivityBlock, EventCacheHit, EventMode, TokenUsage } from "../transcripts/sources/transcriptTypes.ts";
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
} from "./claudeNetworkSource.ts";

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

const MESSAGE_STREAM_AUTHORITIES = new Set(["api.anthropic.com", "a-api.anthropic.com"]);
const MESSAGE_STREAM_PATH = "/v1/messages";
const MAX_PENDING_PER_FLOW = 200;
const TOOL_RESULT_PREVIEW_CAP = 16_000;

interface LiveMessage {
  id: string;
  /** Raw Anthropic message id (`msg_...`) shared with the durable transcript. */
  messageId?: string;
  ts: number;
  phase: "streaming" | "complete";
  blocks: ActivityBlock[];
  toolRaw: Map<number, string>;
  /** Per-turn prompt-cache summary, from the message's usage record. */
  cacheHit?: EventCacheHit;
}

interface FlowContext {
  sessionId: string | null;
  message: LiveMessage | null;
  pending: Array<{ payload: string; ts: number }>;
  /** True once the observer reported stream end while the body bind was still in flight. */
  ended: boolean;
}

interface SessionTrack {
  lastEventAt: number;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

function isMessageStream(flow: { authority?: unknown; path?: unknown; protocol?: unknown }): boolean {
  if (flow.protocol !== "OBSERVED_PROTOCOL_SSE") return false;
  if (typeof flow.authority !== "string" || !MESSAGE_STREAM_AUTHORITIES.has(flow.authority)) {
    return false;
  }
  return flow.path === MESSAGE_STREAM_PATH;
}

function observedAtMs(event: ObserverEvent): number {
  const value = event.observedAt;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function usageFor(model: string | undefined, usage: unknown, ts: number): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const current = input + cacheCreate + cacheRead + output;
  if (current <= 0) return null;
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
  };
}

// Per-turn prompt-cache summary for the cache-hit badge, matching the durable
// transcript adapter's semantics: cached = `cache_read_input_tokens`, input =
// the whole prompt including what this turn wrote to the cache.
function extractClaudeCacheHit(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const total = input + cacheCreate + cacheRead;
  if (total <= 0) return undefined;
  return { cached: cacheRead, input: total };
}

export class ClaudeLiveBackend implements AgentBackend {
  readonly id = "claude";
  readonly capabilities = CLAUDE_LIVE_CAPABILITIES;

  private readonly projections = new Map<string, LiveAgentProjection>();
  private readonly tracks = new Map<string, SessionTrack>();
  private readonly subscriberCounts = new Map<string, number>();
  private readonly usage = new Map<string, TokenUsage>();
  private readonly binds = new Map<string, string>();
  private readonly flowContexts = new Map<string, FlowContext>();
  private subscription: ObserverSubscription | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private lastError: unknown = null;

  constructor(
    private readonly endpoint: URL = config.proxyObserverEndpoint,
    private readonly enabled: boolean = config.claudeLiveEnabled,
    private readonly maxSessions: number = config.claudeLiveMaxSessions,
  ) {}

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
    const projection = this.projections.get(sessionId);
    if (!projection) return undefined;
    const catalogSession = findSession("claude", sessionId);
    if (!catalogSession) return undefined;
    const track = this.tracks.get(sessionId);
    return {
      sessionId,
      source: "claude",
      projectPath: catalogSession.project,
      title: catalogSession.title ?? sessionId,
      lastEventAt: track?.lastEventAt ?? 0,
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
    const projection = this.projectionFor(sessionId);
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
    const projection = this.projectionFor(sessionId);
    this.subscriberCounts.set(sessionId, (this.subscriberCounts.get(sessionId) ?? 0) + 1);
    const unsubscribe = projection.subscribe(afterSequence, listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      const remaining = (this.subscriberCounts.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.subscriberCounts.set(sessionId, remaining);
      else this.subscriberCounts.delete(sessionId);
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
    return this.usage.get(sessionId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.subscription?.close();
    this.subscription = null;
    for (const track of this.tracks.values()) {
      if (track.dropTimer) clearTimeout(track.dropTimer);
    }
    this.projections.clear();
    this.tracks.clear();
    this.subscriberCounts.clear();
    this.usage.clear();
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
      this.scheduleSessionDrop(sessionId);
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
    this.ensureProjection(sessionId);
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
      this.scheduleSessionDrop(sessionId);
    }
  }

  private publishToolResults(
    sessionId: string,
    flowId: string,
    results: ToolResultItem[],
    ts: number,
  ): void {
    const projection = this.ensureProjection(sessionId);
    const blocks: ActivityBlock[] = results.map((result) => {
      const preview = result.text.slice(0, TOOL_RESULT_PREVIEW_CAP);
      const hiddenChars = result.text.length - preview.length;
      return {
        kind: "tool_result",
        ...(result.toolUseId ? { callId: result.toolUseId } : {}),
        preview,
        hiddenChars: hiddenChars > 0 ? hiddenChars : undefined,
        hiddenLines: hiddenChars > 0 ? (result.text.slice(TOOL_RESULT_PREVIEW_CAP).match(/\n/g) ?? []).length : undefined,
      };
    });
    projection.upsert({
      id: `claude-live:user:${flowId}`,
      ts,
      type: "user",
      phase: "complete",
      blocks: blocks.map((block) => ({ ...block })),
    });
  }

  private applyPayload(sessionId: string, flowId: string, payload: string, ts: number): void {
    this.touch(sessionId);
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
      const created = { sessionId, message: null, pending: [], ended: false };
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
    const projection = this.ensureProjection(sessionId);
    switch (event.kind) {
      case "message_start": {
        const messageId = typeof event.message.id === "string" && event.message.id
          ? event.message.id
          : undefined;
        context.message = {
          id: `claude-live:${messageId ?? flowId}`,
          ...(messageId ? { messageId } : {}),
          ts,
          phase: "streaming",
          blocks: [],
          toolRaw: new Map(),
        };
        const model = typeof event.message.model === "string" ? event.message.model : undefined;
        const usage = usageFor(model, event.message.usage, ts);
        if (usage) this.usage.set(sessionId, usage);
        projection.setState("running");
        this.publishMessage(projection, context.message);
        break;
      }
      case "content_block_start": {
        const message = context.message;
        if (!message) break;
        const block = blockForStart(event.contentBlock);
        message.blocks[event.index] = block;
        this.publishMessage(projection, message);
        break;
      }
      case "content_block_delta": {
        const message = context.message;
        if (!message) break;
        const block = message.blocks[event.index];
        const delta = event.delta;
        if (delta && typeof delta === "object") {
          if (typeof delta.text === "string") {
            const textBlock = block ?? { kind: "text", text: "" };
            if (textBlock.kind === "text" || textBlock.kind === "reasoning") {
              textBlock.text = `${textBlock.text ?? ""}${delta.text}`;
              message.blocks[event.index] = textBlock;
            }
          } else if (typeof delta.thinking === "string") {
            const reasoningBlock = block ?? { kind: "reasoning", text: "" };
            if (reasoningBlock.kind === "reasoning" || reasoningBlock.kind === "text") {
              reasoningBlock.text = `${reasoningBlock.text ?? ""}${delta.thinking}`;
              message.blocks[event.index] = reasoningBlock;
            }
          } else if (typeof delta.partial_json === "string") {
            message.toolRaw.set(event.index, `${message.toolRaw.get(event.index) ?? ""}${delta.partial_json}`);
          }
        }
        this.publishMessage(projection, message);
        break;
      }
      case "content_block_stop": {
        const message = context.message;
        if (!message) break;
        const raw = message.toolRaw.get(event.index);
        const block = message.blocks[event.index];
        if (block?.kind === "tool_use" && typeof raw === "string" && raw) {
          try {
            block.input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // Incomplete input_json: leave the block without an input rather than dropping it.
          }
          message.toolRaw.delete(event.index);
        }
        this.publishMessage(projection, message);
        break;
      }
      case "message_delta": {
        const message = context.message;
        if (!message) break;
        const model = this.usage.get(sessionId)?.model;
        const usage = usageFor(model, event.usage, ts);
        if (usage) this.usage.set(sessionId, usage);
        const cacheHit = extractClaudeCacheHit(event.usage);
        if (cacheHit) message.cacheHit = cacheHit;
        break;
      }
      case "message_stop": {
        const message = context.message;
        if (!message) break;
        message.phase = "complete";
        message.toolRaw.clear();
        projection.setState("idle");
        this.publishMessage(projection, message);
        break;
      }
      case "error": {
        const message = context.message;
        if (message) {
          message.phase = "complete";
          message.blocks.push({ kind: "metadata", label: "Agent error", text: "stream ended with an API error" });
          this.publishMessage(projection, message);
        }
        projection.setState("error");
        break;
      }
      case "ping":
        break;
    }
  }

  private finishMessage(sessionId: string, flowId: string): void {
    const context = this.flowContexts.get(flowId);
    if (!context?.message) return;
    if (context.message.phase === "streaming") {
      context.message.phase = "complete";
      context.message.toolRaw.clear();
      this.publishMessage(this.projectionFor(sessionId), context.message);
    }
  }

  private publishMessage(projection: LiveAgentProjection, message: LiveMessage): void {
    // LiveAgentProjection stores what it is handed by reference and bumps
    // `revision` only when the persisted event differs from the new one. We
    // accumulate text by mutating the message's block objects in place, so a
    // fresh (shallow-cloned) block array must be handed over each time or the
    // projection would compare the same object to itself and skip every delta.
    projection.upsert({
      id: message.id,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ts: message.ts,
      type: "assistant",
      phase: message.phase,
      blocks: message.blocks.map((block) => ({ ...block })),
      ...(message.cacheHit ? { cacheHit: message.cacheHit } : {}),
    });
  }

  // --- lifecycle helpers ----------------------------------------------------

  private projectionFor(sessionId: string): LiveAgentProjection {
    const projection = this.projections.get(sessionId);
    if (!projection) throw new AgentSessionNotFoundError(`claude live session "${sessionId}" was not found`);
    return projection;
  }

  private ensureProjection(sessionId: string): LiveAgentProjection {
    let projection = this.projections.get(sessionId);
    if (!projection) {
      projection = new LiveAgentProjection();
      this.projections.set(sessionId, projection);
      this.enforceSessionBound();
    }
    this.touch(sessionId);
    return projection;
  }

  private touch(sessionId: string): void {
    const existing = this.tracks.get(sessionId);
    if (existing?.dropTimer) {
      clearTimeout(existing.dropTimer);
      existing.dropTimer = null;
    }
    this.tracks.set(sessionId, { lastEventAt: Date.now(), dropTimer: existing?.dropTimer ?? null });
  }

  private scheduleSessionDrop(sessionId: string): void {
    if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
    const track = this.tracks.get(sessionId);
    if (track?.dropTimer) return;
    const timer = setTimeout(() => {
      if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
      this.projections.delete(sessionId);
      this.tracks.delete(sessionId);
      this.usage.delete(sessionId);
    }, config.claudeLiveIdleDropMs);
    timer.unref?.();
    this.tracks.set(sessionId, { lastEventAt: track?.lastEventAt ?? Date.now(), dropTimer: timer });
  }

  private enforceSessionBound(): void {
    while (this.projections.size > this.maxSessions) {
      let victim: string | null = null;
      for (const [sessionId, count] of this.subscriberCounts) {
        if (count === 0) {
          victim = sessionId;
          break;
        }
      }
      if (victim === null) {
        let oldest = Infinity;
        for (const [sessionId, track] of this.tracks) {
          if (track.lastEventAt < oldest) {
            oldest = track.lastEventAt;
            victim = sessionId;
          }
        }
      }
      if (victim === null) break;
      this.dropSession(victim);
    }
  }

  private dropSession(sessionId: string): void {
    if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
    this.projections.delete(sessionId);
    this.tracks.delete(sessionId);
    this.usage.delete(sessionId);
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

function blockForStart(contentBlock: { type?: unknown; name?: unknown; id?: unknown }): ActivityBlock {
  switch (contentBlock.type) {
    case "thinking":
      return { kind: "reasoning", text: "" };
    case "tool_use":
      return {
        kind: "tool_use",
        tool: typeof contentBlock.name === "string" ? contentBlock.name : "tool",
        input: {},
        ...(typeof contentBlock.id === "string" && contentBlock.id ? { callId: contentBlock.id } : {}),
      };
    case "text":
    default:
      return { kind: "text", text: "" };
  }
}
