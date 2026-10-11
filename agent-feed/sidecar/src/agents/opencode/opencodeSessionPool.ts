// Who owns an opencode session's life: opening, adopting, refreshing, reaping.
//
// The backend issues commands and answers queries; this pool holds everything those need to
// touch: the owned map, the in-flight starts, the serve-event subscription and the idle
// reaper. One state owner rather than two sharers, because every method on both sides reads
// the same maps -- splitting them any other way would be two classes editing each other's
// fields. The backend reaches sessions only through `open`, `create` and `subscribe`, and
// mutates nothing here except through the `OwnedSession` those hand back.

import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "@/config/config";
import type {
  AgentCommandReceipt,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentTimelinePage,
  AgentUiEvent,
} from "@/agents/agentBackend";
import { AgentSessionNotFoundError } from "@/agents/agentBackend";
import { AgentUiBroker } from "@/agents/agentUiBroker";
import { LiveAgentProjection, type TimelineEnvelope } from "@/agents/liveAgentProjection";
import { OpencodeEventMapper, type OpencodeSyncResult } from "@/agents/opencode/opencodeEventMapper";
import { OpencodeImageStore } from "@/agents/opencode/opencodeImageStore";
import { OpencodeModelLimits } from "@/agents/opencode/opencodeModelLimits";
import { readOpencodeMeter } from "@/agents/opencode/opencodeUsage";
import {
  mergedRead,
  OpencodeStreamTail,
  type OpencodeStreamedPart,
} from "@/agents/opencode/opencodeStreamTail";
import { OpencodeCompactionWatch } from "@/agents/opencode/opencodeCompactionWatch";
import { OpencodeServeEvents, type OpencodeRunState } from "@/agents/opencode/opencodeServeEvents";
import { latestCompletedCompactionId, readOpencodeHistory, readOpencodeTail } from "@/agents/opencode/opencodeHistory";
import { describeServeError, isServeUnauthorized, opencodeClient, resetOpencodeClient } from "@/agents/opencode/opencodeClient";
import { notifyOpencodeSessionChanged } from "@/transcripts/catalog/opencodeCatalog";
import type { EventMode, TokenUsage } from "@/transcripts/transcriptTypes";

export interface OpencodeSessionLocation {
  sessionId: string;
  projectPath: string;
}

export interface OpencodePoolOptions {
  resolveSession: (sessionId: string) => OpencodeSessionLocation | undefined;
  onSessionCreated: (location: OpencodeSessionLocation) => void;
  onCatalogChanged: () => void;
  capabilities: AgentSessionCapabilities;
  /** Overridden in tests so no serve has to run; defaults to this machine's. */
  client?: () => OpencodeClient | null;
  now?: () => number;
}

export interface OwnedSession {
  projection: LiveAgentProjection;
  mapper: OpencodeEventMapper;
  ui: AgentUiBroker;
  subscribers: number;
  lastTouchedAt: number;
  lastRefreshAt: number;
  commandTail: Promise<void>;
  commands: Map<string, { signature: string; promise: Promise<AgentCommandReceipt> }>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshQueued: boolean;
  /** A queued refresh must rebuild history, not just read the tail. */
  refreshFull: boolean;
  /** The newest landed compaction already folded into the projection. */
  compactionBoundaryId: string | null;
  usage: TokenUsage | null;
  /**
   * The session's current model as `providerID/modelID`, or null while the serve has not named
   * one. Tracked beside usage rather than inside it: usage blanks across a post-compaction gap
   * while the model survives it, and the panel's switcher reads this without touching the meter.
   */
  model: string | null;
  disposed: boolean;
}

/** Collapses one burst of serve events into one re-read. */
const REFRESH_COALESCE_MS = 300;
/**
 * How old a projection may be before opening it re-reads the serve.
 *
 * Bounds staleness for polling readers and reconnects. Inside the bound the
 * open path serves memory; outside it pays one round trip.
 */
const FRESHNESS_BOUND_MS = 10_000;

export class OpencodeSessionPool {
  private readonly owned = new Map<string, OwnedSession>();
  private readonly starts = new Map<string, Promise<OwnedSession>>();
  private readonly modelLimits = new OpencodeModelLimits();
  /** The pictures live rows drew, waiting for the image route's on-demand reads. */
  private readonly imageStore = new OpencodeImageStore();
  /** The turn being written, held from the serve's own deltas rather than re-read. */
  private readonly streaming = new OpencodeStreamTail();
  private readonly now: () => number;
  private readonly serve: () => OpencodeClient | null;
  private readonly events: OpencodeServeEvents;
  private readonly compactions = new OpencodeCompactionWatch();
  private readonly reaper: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: OpencodePoolOptions) {
    this.now = options.now ?? Date.now;
    this.serve = options.client ?? opencodeClient;
    this.events = new OpencodeServeEvents(
      {
        refresh: (sessionId, full = false) => this.scheduleRefresh(sessionId, full),
        setRunState: (sessionId, state) => this.setRunState(sessionId, state),
        catalogChanged: () => this.options.onCatalogChanged(),
        hasSession: (sessionId) => this.owned.has(sessionId),
        uiFor: (sessionId) => this.owned.get(sessionId)?.ui ?? null,
        compactionStarted: (sessionId, messageId) => this.compactions.begin(messageId, sessionId),
        compactionDelta: (_sessionId, messageId, text) => {
          this.compactions.append(messageId, text);
        },
        compactionDeltaForSession: (sessionId, text) => {
          this.compactions.appendToSession(sessionId, text);
        },
        compactionEnded: (_sessionId, messageId) => {
          this.compactions.end(messageId);
        },
        compactionSettled: (sessionId) => this.compactions.endSession(sessionId),
        streamPart: (sessionId, part) => this.streamPart(sessionId, part),
      },
      this.serve,
    );
    const idleMs = config.opencodeIdleMs;
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(30_000, idleMs));
    this.reaper.unref?.();
  }

  async open(sessionId: string): Promise<OwnedSession> {
    this.assertActive();
    const current = this.owned.get(sessionId);
    if (current) {
      await this.ensureFresh(current, sessionId);
      return current;
    }
    const pending = this.starts.get(sessionId);
    if (pending) return pending;
    const location = this.options.resolveSession(sessionId);
    if (!location) throw new AgentSessionNotFoundError(`opencode session "${sessionId}" was not found`);
    const start = this.adopt(location.sessionId)
      .finally(() => this.starts.delete(sessionId));
    this.starts.set(sessionId, start);
    return start;
  }

  /** Creates the serve session without adopting it: creation is remote, ownership starts at open. */
  async create(projectPath: string): Promise<AgentSessionDescriptor> {
    this.assertActive();
    const client = this.serve();
    if (!client) throw new Error("opencode serve password is not configured");
    const response = await client.v2.session.create({ location: { directory: projectPath } });
    if (response.error) throw new Error(`create: ${describeServeError(response.error)}`);
    const created = response.data?.data;
    if (!created || typeof created.id !== "string") throw new Error("opencode created a session without an id");
    const location = { sessionId: created.id, projectPath };
    this.options.onSessionCreated(location);
    return {
      sessionId: created.id,
      source: "opencode",
      projectPath,
      title: created.title || created.id,
      lastEventAt: this.now(),
      activity: "ready",
      capabilities: this.options.capabilities,
    };
  }

  describeSession(sessionId: string): AgentSessionDescriptor | undefined {
    if (this.disposed) return undefined;
    const location = this.options.resolveSession(sessionId);
    if (!location) return undefined;
    const owned = this.owned.get(sessionId);
    return {
      sessionId,
      source: "opencode",
      projectPath: location.projectPath,
      title: sessionId,
      lastEventAt: this.now(),
      activity: owned && owned.projection.runState === "running" ? "live" : "ready",
      capabilities: this.options.capabilities,
    };
  }

  /** Latest occupancy the pool has seen, for the timeline's meter. */
  sessionUsage(sessionId: string): TokenUsage | null {
    return this.owned.get(sessionId)?.usage ?? null;
  }

  /**
   * The session's current model as `providerID/modelID`, or null while the serve has not named
   * one. Answered even across the post-compaction gap that blanks usage: a compaction rewrites
   * context, never the model.
   */
  sessionModel(sessionId: string): string | null {
    return this.owned.get(sessionId)?.model ?? null;
  }

  /**
   * The bytes behind one image block, addressed the way the panel addresses it: the event's
   * position in the projection, then the block's position in the event. Null where the session
   * is not owned, the event moved, or the block is no picture -- the panel then draws the row
   * without it rather than failing the row.
   *
   * The ordinal counts image blocks, not blocks: it is the picture's place among its event's
   * pictures, which is how the mapper numbered it at sync time.
   */
  imageFor(
    sessionId: string,
    eventIndex: number,
    blockIndex: number,
  ): { mediaType: string; data: string } | null {
    const owned = this.owned.get(sessionId);
    if (!owned || owned.disposed) return null;
    if (!Number.isSafeInteger(eventIndex) || !Number.isSafeInteger(blockIndex)) return null;
    const [event] = owned.projection.page(eventIndex, 1);
    if (!event || event.index !== eventIndex) return null;
    const blocks = event.blocks ?? [];
    if (blockIndex < 0 || blockIndex >= blocks.length) return null;
    if (blocks[blockIndex]?.kind !== "image") return null;
    let ordinal = -1;
    for (let index = 0; index <= blockIndex; index++) {
      if (blocks[index]?.kind === "image") ordinal += 1;
    }
    return this.imageStore.lookup(sessionId, event.id, ordinal);
  }

  /**
   * What the session's summariser has streamed so far, or null when it is not compacting.
   *
   * Probed by the timeline route, the way Claude's live backend is probed: a compaction writes
   * no durable message until it lands, so this is the only thing on screen while it streams.
   */
  compactionSummary(sessionId: string): string | null {
    return this.compactions.summary(sessionId);
  }

  onCompaction(listener: (sessionId: string, active: boolean) => void): () => void {
    return this.compactions.onChange(listener);
  }

  onCompactionSummary(
    listener: (sessionId: string, text: string, replace: boolean) => void,
  ): () => void {
    return this.compactions.onSummary(listener);
  }

  async page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage> {
    const owned = await this.open(sessionId);
    owned.lastTouchedAt = this.now();
    const snapshot = owned.projection.snapshot(offset, limit);
    return {
      events: snapshot.events,
      total: owned.projection.total,
      mode: "nice",
      sequence: snapshot.sequence,
      runState: snapshot.runState,
      queue: snapshot.queue,
      projectionId: snapshot.projectionId,
    };
  }

  async subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (envelope: TimelineEnvelope) => void,
  ): Promise<() => void> {
    const owned = await this.open(sessionId);
    owned.lastTouchedAt = this.now();
    owned.subscribers += 1;
    this.events.setWanted(true);
    const unsubscribe = owned.projection.subscribe(afterSequence, listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      owned.subscribers = Math.max(0, owned.subscribers - 1);
      owned.lastTouchedAt = this.now();
      if (!this.hasSubscribers()) this.events.setWanted(false);
    };
  }

  subscribeUi(sessionId: string, listener: (event: AgentUiEvent) => void): Promise<() => void> {
    return this.open(sessionId).then((owned) => owned.ui.subscribe(listener));
  }

  reapIdle(now = this.now()): void {
    for (const [sessionId, owned] of this.owned) {
      if (owned.disposed || owned.subscribers > 0) continue;
      if (owned.projection.runState === "running") continue;
      if (now - owned.lastTouchedAt < config.opencodeIdleMs) continue;
      this.owned.delete(sessionId);
      this.disposeOwned(owned);
      this.imageStore.dropSession(sessionId);
      this.streaming.clear(sessionId);
    }
  }

  hasSubscribers(): boolean {
    for (const owned of this.owned.values()) {
      if (owned.subscribers > 0) return true;
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);
    await this.events.dispose();
    for (const owned of this.owned.values()) this.disposeOwned(owned);
    this.owned.clear();
    this.starts.clear();
    this.imageStore.clear();
    this.streaming.clearAll();
  }

  /**
   * Re-reads a projection whose last refresh is older than the freshness
   * bound, so polling readers and reconnects converge even when no serve
   * event arrived while they were away. Long subscriptions stay event-driven;
   * this is only the open path.
   */
  private async ensureFresh(owned: OwnedSession, sessionId: string): Promise<void> {
    if (owned.disposed) return;
    if (this.now() - owned.lastRefreshAt < FRESHNESS_BOUND_MS && owned.lastRefreshAt > 0) return;
    if (owned.refreshQueued) return;
    owned.refreshQueued = true;
    try {
      await this.refresh(sessionId, false);
    } finally {
      owned.refreshQueued = false;
    }
  }

  private async adopt(sessionId: string): Promise<OwnedSession> {
    const projection = new LiveAgentProjection();
    const owned: OwnedSession = {
      projection,
      mapper: new OpencodeEventMapper(projection),
      ui: new AgentUiBroker(),
      subscribers: 0,
      lastTouchedAt: this.now(),
      lastRefreshAt: 0,
      commandTail: Promise.resolve(),
      commands: new Map(),
      refreshTimer: null,
      refreshQueued: false,
      refreshFull: false,
      compactionBoundaryId: null,
      usage: null,
      model: null,
      disposed: false,
    };
    this.owned.set(sessionId, owned);
    await this.refresh(sessionId, true);
    return owned;
  }

  /**
   * Re-reads one session's messages and folds them into its projection.
   *
   * The only read path, used for seed and live alike. A seed walks the whole
   * history oldest-first; a live refresh reads only the latest page, because
   * durable messages are immutable once completed and only the open tail can
   * still move. A completed compaction is the exception: it can rewrite the
   * message set, so that refresh re-reads the whole history and replaces the
   * projection rather than upserting onto rows the serve has removed.
   */
  private async refresh(sessionId: string, full: boolean): Promise<void> {
    const owned = this.owned.get(sessionId);
    const client = this.serve();
    if (!owned || owned.disposed || !client) return;
    try {
      const [messages, info] = await Promise.all([
        full ? readOpencodeHistory(sessionId) : readOpencodeTail(sessionId),
        client.v2.session.get({ sessionID: sessionId }),
      ]);
      // The SDK resolves HTTP failures as `{ error }` rather than throwing
      // (throwOnError defaults to false), so an unchecked response reads as
      // an empty session: a thread that renders nothing with nothing in the
      // log. Fail loud here instead.
      if (info.error) throw new Error(`get: ${describeServeError(info.error)}`);
      const current = this.owned.get(sessionId);
      if (!current || current.disposed) return;
      // A new completed compaction changes the message set, not just its tail. Read the whole
      // history before folding it in, or the projection keeps rows the serve has replaced and
      // the panel's last line stays the pre-compaction tool call. The id keeps a later tail
      // refresh from repeating that full read for the same boundary.
      const tailCompactionId = latestCompletedCompactionId(messages);
      const replace = full || (tailCompactionId !== null && tailCompactionId !== current.compactionBoundaryId);
      const history = replace && !full ? await readOpencodeHistory(sessionId) : messages;
      const historyBoundaryId = latestCompletedCompactionId(history);
      if (replace || historyBoundaryId !== null) current.compactionBoundaryId = historyBoundaryId;
      // Settled before drawn, and the merge drawn rather than the read: a read of the message the
      // serve is still writing is a snapshot of a row mid-write, regularly behind the words already
      // on screen because the serve writes a reasoning part at the end. Drawn on its own it replaced
      // a live row with a thinner one -- the thinking emptied out and the tool call took its place,
      // then both were right again on the next read. Substituting the merge for that one message is
      // what makes it a single draw, so the row only ever grows. See `opencodeStreamTail` for the rule.
      const streaming = this.streaming.settle(sessionId, history);
      const drawable = streaming ? mergedRead(history, streaming) : history;
      let result!: OpencodeSyncResult;
      if (replace) {
        current.projection.replace(() => {
          result = current.mapper.sync(drawable);
        });
      } else {
        result = current.mapper.sync(drawable);
      }
      this.imageStore.store(sessionId, result.images);
      // The meter's own rules, and the gap a compaction leaves in them, live in one place.
      const meter = await readOpencodeMeter({
        session: info.data?.data,
        history,
        previous: current.usage,
        limits: this.modelLimits,
        now: this.now,
      });
      if (meter) {
        const switched = meter.model !== current.model;
        ({ model: current.model, usage: current.usage } = meter);
        if (switched) current.projection.announce(); // after storing: the publish is synchronous and the stamp reads `model`
      }
      // A turn with words still arriving is running even when the read's own last message reads
      // finished, which is the normal shape while a tool call is in flight.
      current.projection.setState(streaming || result.open ? "running" : "idle");
      current.lastTouchedAt = this.now();
      current.lastRefreshAt = current.lastTouchedAt;
      notifyOpencodeSessionChanged(sessionId);
    } catch (error) {
      if (isServeUnauthorized(error)) resetOpencodeClient();
      console.error("opencode session refresh failed", { sessionId, error: String(error) });
    }
  }

  /**
   * The running turn's own words, drawn as the serve publishes them.
   *
   * Nothing is read here. The serve is already sending the chunk that extends the row, so the
   * read this replaces -- coalesced, once per burst -- could only ever be a later copy of what
   * this already holds, and it re-read and re-mapped the newest 200 messages to move one line.
   * The tail hands back a message shaped like the durable one, the same mapper draws it, and
   * the row's id is the durable id, so the closing read replaces this row in place.
   *
   * Run state follows from the row rather than being set here: words arriving mean the turn is
   * running, and the read that ends the step is what says it stopped. Marking the session
   * touched matters for the same reason -- a reader who opens mid-turn gets the live row from
   * here without waiting for anything.
   */
  private streamPart(sessionId: string, part: OpencodeStreamedPart): void {
    const owned = this.owned.get(sessionId);
    if (!owned || owned.disposed) return;
    const message = this.streaming.apply(sessionId, part, this.now());
    if (!message) return;
    owned.mapper.sync([message]);
    owned.projection.setState("running");
    owned.lastTouchedAt = this.now();
  }

  private scheduleRefresh(sessionId: string, full = false): void {
    const owned = this.owned.get(sessionId);
    if (!owned || owned.disposed) return;
    owned.refreshFull = owned.refreshFull || full;
    if (owned.refreshTimer) return;
    owned.refreshTimer = setTimeout(() => {
      if (owned.refreshTimer) {
        owned.refreshTimer = null;
        const rebuild = owned.refreshFull;
        owned.refreshFull = false;
        void this.refresh(sessionId, rebuild);
      }
    }, REFRESH_COALESCE_MS);
    owned.refreshTimer.unref?.();
  }

  private setRunState(sessionId: string, state: OpencodeRunState): void {
    const owned = this.owned.get(sessionId);
    if (owned && !owned.disposed) {
      owned.projection.setState(state);
      owned.lastTouchedAt = this.now();
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("opencode session pool is disposed");
  }

  private disposeOwned(owned: OwnedSession): void {
    if (owned.disposed) return;
    owned.disposed = true;
    if (owned.refreshTimer) clearTimeout(owned.refreshTimer);
    owned.refreshTimer = null;
    owned.ui.dispose();
  }
}
