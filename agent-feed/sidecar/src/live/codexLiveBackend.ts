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

import { config, contextWindowFor } from "../config.ts";
import type {
  AgentBackend,
  AgentCommandReceipt,
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
  CODECX_OBSERVER_FILTER,
  CODECX_RESPONSES_AUTHORITY,
  CODECX_RESPONSES_PATH,
  decodeWebSocketMessage,
  extractCodexSessionId,
  mapCodexMessage,
  type CodexMessageEvent,
  type ObservedRequestHeader,
} from "./codexNetworkSource.ts";
import type { ObserverEvent, ObserverSubscription } from "./claudeNetworkSource.ts";
import { subscribeToObserver } from "./claudeNetworkSource.ts";

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

const TOOL_RESULT_PREVIEW_CAP = 16_000;

interface LiveItem {
  id: string;
  ts: number;
  phase: "streaming" | "complete";
  blocks: ActivityBlock[];
  toolRaw?: Map<string, string>;
}

interface FlowContext {
  sessionId: string;
  /** Item ids still streaming on this flow, so an abrupt socket end can complete them. */
  streaming: Set<string>;
  ended: boolean;
}

interface SessionTrack {
  lastEventAt: number;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

function isCodexStream(flow: {
  authority?: unknown;
  path?: unknown;
  protocol?: unknown;
}): boolean {
  if (flow.protocol !== "OBSERVED_PROTOCOL_WEBSOCKET") return false;
  if (typeof flow.authority !== "string" || flow.authority !== CODECX_RESPONSES_AUTHORITY) {
    return false;
  }
  return flow.path === CODECX_RESPONSES_PATH;
}

function observedAtMs(event: ObserverEvent): number {
  const value = event.observedAt;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// Cached input tokens from the Responses-API usage shape the codex websocket
// publishes on `response.completed`. The transcript's `token_count` record
// normalizes this to a flat `cached_input_tokens`; the API shape nests it under
// `input_tokens_details.cached_tokens`. Both are accepted so a drift in either
// representation still feeds the badge. Undefined when neither is present, so
// a missing cache field never fabricates a 0% badge.
function cachedInputTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.input_tokens_details;
  const nested = details && typeof details === "object"
    ? (details as Record<string, unknown>).cached_tokens
    : undefined;
  const flat = usage.cached_input_tokens;
  const value = typeof nested === "number" ? nested : flat;
  return typeof value === "number" && value >= 0 ? value : undefined;
}

function usageFor(model: string | undefined, usage: unknown, ts: number): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const total = typeof u.total_tokens === "number" ? u.total_tokens : 0;
  // `total_tokens` already includes the cached portion: `input_tokens` counts
  // the full prompt, with `cached_tokens` a subset of it. This mirrors the
  // durable transcript adapter, where the meter is `total_tokens` as published.
  const current = total > 0 ? total : input + output;
  if (current <= 0) return null;
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
  };
}

// Per-turn prompt-cache summary for the cache-hit badge. `input` is the full
// prompt (`input_tokens` already includes the cached portion), so the fraction
// `cached / input` is the true cache-hit rate. Both numbers must be present;
// a usage record without cache info reports no badge.
function cacheHitFor(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cached = cachedInputTokens(u);
  if (input <= 0 || cached === undefined) return undefined;
  return { cached, input };
}

export class CodexLiveBackend implements AgentBackend {
  readonly id = "codex";
  readonly capabilities = CODECX_LIVE_CAPABILITIES;

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
    private readonly enabled: boolean = config.codexLiveEnabled,
    private readonly maxSessions: number = config.codexLiveMaxSessions,
  ) {}

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
    const projection = this.projections.get(sessionId);
    const track = this.tracks.get(sessionId);
    return {
      sessionId,
      source: "codex",
      projectPath: catalogSession.project,
      title: catalogSession.title ?? sessionId,
      lastEventAt: track?.lastEventAt ?? 0,
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
    const projection = this.ensureProjection(sessionId);
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
    const projection = this.ensureProjection(sessionId);
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
    if (event.websocketMessageObserved) {
      this.acceptMessage(event.websocketMessageObserved, ts);
    }
    if (event.streamEnded) {
      this.acceptStreamEnded(event.streamEnded.flowId, ts);
    }
  }

  private acceptFlowUpserted(flow: {
    flowId?: unknown;
    authority?: unknown;
    path?: unknown;
    protocol?: unknown;
    requestHeaders?: unknown;
  }, ts: number): void {
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
    this.ensureProjection(sessionId);
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

  private acceptStreamEnded(flowId: unknown, ts: number): void {
    if (typeof flowId !== "string") return;
    const context = this.flowContexts.get(flowId);
    if (!context) return;
    this.finishStreaming(context);
    this.scheduleSessionDrop(context.sessionId);
    this.dropFlow(flowId);
  }

  private applyPayload(sessionId: string, flowId: string, payload: string, ts: number): void {
    this.touch(sessionId);
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
    this.applyEvent(sessionId, flowId, context, event, ts);
  }

  private applyEvent(
    sessionId: string,
    flowId: string,
    context: FlowContext,
    event: CodexMessageEvent,
    ts: number,
  ): void {
    const projection = this.ensureProjection(sessionId);
    switch (event.kind) {
      case "response_create":
        projection.setState("running");
        this.publishTurnInput(projection, event.input, ts);
        break;
      case "response_created":
      case "response_in_progress":
        projection.setState("running");
        break;
      case "output_item_added": {
        const item = event.item;
        const itemId = typeof item.id === "string" && item.id ? item.id : null;
        const block = blockForItem(item);
        if (!itemId || !block) break;
        context.streaming.add(itemId);
        this.upsertItem(sessionId, itemId, ts, "streaming", [block]);
        break;
      }
      case "output_text_delta": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const delta = event.delta;
        if (typeof delta !== "string" || delta.length === 0) break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        const textBlock = current.blocks[0];
        if (textBlock?.kind === "text") {
          textBlock.text = `${textBlock.text ?? ""}${delta}`;
          this.upsertItem(sessionId, itemId, current.ts, current.phase, current.blocks);
        }
        break;
      }
      case "output_text_done": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        const text = typeof event.text === "string" ? event.text : current.blocks[0]?.text;
        const block = current.blocks[0];
        if (block?.kind === "text") block.text = text ?? block.text;
        context.streaming.delete(itemId);
        this.upsertItem(sessionId, itemId, current.ts, "complete", current.blocks);
        break;
      }
      case "reasoning_summary_text_delta": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const delta = event.delta;
        if (typeof delta !== "string" || delta.length === 0) break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        const block = current.blocks[0];
        if (block?.kind === "reasoning") {
          block.text = `${block.text ?? ""}${delta}`;
          this.upsertItem(sessionId, itemId, current.ts, current.phase, current.blocks);
        }
        break;
      }
      case "reasoning_summary_text_done": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        const text = typeof event.text === "string" ? event.text : current.blocks[0]?.text;
        const block = current.blocks[0];
        if (block?.kind === "reasoning") block.text = text ?? block.text;
        context.streaming.delete(itemId);
        this.upsertItem(sessionId, itemId, current.ts, "complete", current.blocks);
        break;
      }
      case "function_call_arguments_delta": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const delta = event.delta;
        if (typeof delta !== "string") break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        if (!current.toolRaw) current.toolRaw = new Map();
        current.toolRaw.set(itemId, `${current.toolRaw.get(itemId) ?? ""}${delta}`);
        break;
      }
      case "function_call_arguments_done": {
        const itemId = event.itemId;
        if (typeof itemId !== "string") break;
        const current = this.itemFor(sessionId, itemId);
        if (!current) break;
        const raw = typeof event.arguments === "string" ? event.arguments : current.toolRaw?.get(itemId);
        const block = current.blocks[0];
        if (block?.kind === "tool_use" && typeof raw === "string" && raw) {
          try {
            block.input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // Incomplete arguments: leave the block without an input rather than dropping it.
          }
        }
        current.toolRaw?.delete(itemId);
        context.streaming.delete(itemId);
        this.upsertItem(sessionId, itemId, current.ts, "complete", current.blocks);
        break;
      }
      case "output_item_done": {
        const itemId = event.item.id;
        if (typeof itemId !== "string") break;
        context.streaming.delete(itemId);
        const current = this.itemFor(sessionId, itemId);
        if (!current || current.phase === "complete") break;
        this.upsertItem(sessionId, itemId, current.ts, "complete", current.blocks);
        break;
      }
      case "response_completed": {
        const response = event.response && typeof event.response === "object"
          ? event.response as Record<string, unknown>
          : {};
        const model = typeof response.model === "string" ? response.model : undefined;
        const usage = usageFor(model, response.usage, ts);
        if (usage) this.usage.set(sessionId, usage);
        const cacheHit = cacheHitFor(response.usage);
        if (cacheHit) {
          // Re-upsert the turn's last assistant row with the badge, the same
          // way the durable path re-stamps a `token_count` line onto the last
          // content event. The projection upserts by id and bumps `revision`,
          // so the panel replaces the row rather than duplicating it.
          const lastId = this.lastContent.get(sessionId);
          const lastItem = lastId !== undefined ? this.itemFor(sessionId, lastId) : undefined;
          if (lastItem && lastId !== undefined) {
            this.upsertItem(sessionId, lastId, lastItem.ts, lastItem.phase, lastItem.blocks, cacheHit);
          }
        }
        this.finishStreaming(context);
        const error = response.error;
        if (error && typeof error === "object") {
          projection.setState("error");
        } else {
          projection.setState("idle");
        }
        break;
      }
      case "ack":
      case "ping":
      case "pong":
      case "server_message":
        break;
    }
  }

  /** Publishes the user's turn input and tool results carried in `response.create`. */
  private publishTurnInput(projection: LiveAgentProjection, input: unknown, ts: number): void {
    if (!Array.isArray(input)) return;
    for (const raw of input) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || item.id.length === 0) continue;
      if (item.type === "function_call_output") {
        const text = typeof item.output === "string" ? item.output : "";
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        const preview = text.slice(0, TOOL_RESULT_PREVIEW_CAP);
        const hiddenChars = text.length - preview.length;
        const blocks: ActivityBlock[] = [{
          kind: "tool_result",
          ...(callId ? { callId } : {}),
          preview,
          hiddenChars: hiddenChars > 0 ? hiddenChars : undefined,
          hiddenLines: hiddenChars > 0 ? (text.slice(TOOL_RESULT_PREVIEW_CAP).match(/\n/g) ?? []).length : undefined,
        }];
        projection.upsert({
          id: `codex-live:user:${item.id}`,
          messageId: item.id,
          ts,
          type: "user",
          phase: "complete",
          blocks,
        });
      } else if (item.type === "message" && item.role === "user") {
        const text = inputText(item.content);
        if (text.length === 0) continue;
        projection.upsert({
          id: `codex-live:user:${item.id}`,
          messageId: item.id,
          ts,
          type: "user",
          phase: "complete",
          blocks: [{ kind: "text", text }],
        });
      }
    }
  }

  private finishStreaming(context: FlowContext): void {
    for (const itemId of [...context.streaming]) {
      this.completeItem(context.sessionId, itemId);
    }
    context.streaming.clear();
  }

  private completeItem(sessionId: string, itemId: string): void {
    const current = this.items.get(sessionId)?.get(itemId);
    if (!current || current.phase === "complete") return;
    this.upsertItem(sessionId, itemId, current.ts, "complete", current.blocks);
  }

  /** In-flight item rows, keyed `sessionId` -> `itemId`, so stream state survives flow churn. */
  private readonly items = new Map<string, Map<string, LiveItem>>();
  /** Last assistant row upserted per session, so `response.completed` can stamp it with the cache badge. */
  private readonly lastContent = new Map<string, string>();

  private itemFor(sessionId: string, itemId: string): LiveItem | undefined {
    return this.items.get(sessionId)?.get(itemId);
  }

  private upsertItem(
    sessionId: string,
    itemId: string,
    ts: number,
    phase: "streaming" | "complete",
    blocks: ActivityBlock[],
    cacheHit?: EventCacheHit,
  ): void {
    const bySession = this.items.get(sessionId) ?? new Map<string, LiveItem>();
    const current = bySession.get(itemId) ?? { id: itemId, ts, phase: "streaming", blocks: [] };
    current.ts = ts;
    current.phase = phase;
    current.blocks = blocks;
    bySession.set(itemId, current);
    this.items.set(sessionId, bySession);
    const projection = this.projectionFor(sessionId);
    projection.upsert({
      id: `codex-live:${itemId}`,
      // The codex item id (msg_.../rs_.../fc_...) is the same id the durable
      // rollout records carry, so the webview can hand the live tail off to
      // the durable row once both are complete.
      messageId: itemId,
      ts,
      type: "assistant",
      phase,
      blocks: blocks.map((block) => ({ ...block })),
      ...(cacheHit ? { cacheHit } : {}),
    });
    // The last prose row is where a `response.completed` cache summary belongs,
    // mirroring how the durable transcript re-stamps its `token_count` line
    // onto the turn's last text event (tool rows fold into clusters that
    // render no badge). Responses can end on a tool call, so an item with no
    // text leaves the previous prose row as the target.
    if (blocks.some((block) => block.kind === "text")) {
      this.lastContent.set(sessionId, itemId);
    }
  }

  // --- lifecycle helpers ----------------------------------------------------

  private projectionFor(sessionId: string): LiveAgentProjection {
    const projection = this.projections.get(sessionId);
    if (!projection) throw new AgentSessionNotFoundError(`codex live session "${sessionId}" was not found`);
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
      this.items.delete(sessionId);
      this.lastContent.delete(sessionId);
    }, config.codexLiveIdleDropMs);
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
    this.items.delete(sessionId);
    this.lastContent.delete(sessionId);
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

function inputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const block = part as Record<string, unknown>;
      if (block.type === "input_text" && typeof block.text === "string") out += block.text;
    }
  }
  return out;
}

function blockForItem(item: Record<string, unknown>): ActivityBlock | null {
  switch (item.type) {
    case "reasoning":
      return { kind: "reasoning", text: "" };
    case "message":
      return { kind: "text", text: "" };
    case "function_call":
      return {
        kind: "tool_use",
        tool: typeof item.name === "string" ? item.name : "tool",
        input: {},
        ...(typeof item.call_id === "string" && item.call_id ? { callId: item.call_id } : {}),
      };
    default:
      return null;
  }
}
