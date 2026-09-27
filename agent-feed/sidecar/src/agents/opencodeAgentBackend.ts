// Owning this machine's opencode sessions through its serve, the way the Pi
// backend owns its runtimes: page and subscribe from a per-session projection,
// send and abort as correlated commands, permissions and questions through the
// shared UI broker.
//
// What it deliberately does NOT do: spawn a server (`createOpencode()` is
// never constructed -- the user already runs one serve per machine), read the
// serve's SQLite (the API is the record), or track stream ids. Live updates
// arrive as serve events and each one schedules a coalesced re-read of that
// session's messages, so there is no delta to lose and no orphan to drop; the
// projection dedupes unchanged rows by content.
//
// Everything travels the serve's `/api` family through `client.v2`. The root
// paths the SDK also generates serve the web UI's HTML in `--service` mode,
// so they are never called: a 200 text/html where JSON was expected is what a
// wrong family looks like, and it was measured before this comment existed.

import type {
  OpencodeClient,
} from "@opencode-ai/sdk/v2/client";
import { config } from "@/config/config";
import { describeServeError, isServeUnauthorized, opencodeClient, resetOpencodeClient, serveRequest } from "@/agents/opencodeClient";
import { stageOpencodeAttachments } from "@/agents/opencodeAttachments";
import type {
  AgentBackend,
  AgentCommandReceipt,
  AgentMessageAttachment,
  AgentMessageDelivery,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentTimelinePage,
  AgentUiEvent,
  AgentUiResponseResult,
} from "@/agents/agentBackend";
import {
  AgentBackendDisposedError,
  AgentCommandConflictError,
  AgentModeUnsupportedError,
  AgentSessionNotFoundError,
} from "@/agents/agentBackend";
import { AgentUiBroker } from "@/agents/agentUiBroker";
import { LiveAgentProjection, type TimelineEnvelope } from "@/agents/liveAgentProjection";
import { OpencodeEventMapper } from "@/agents/opencodeEventMapper";
import { OpencodeServeEvents, type OpencodeRunState } from "@/agents/opencodeServeEvents";
import { readOpencodeHistory, readOpencodeTail } from "@/agents/opencodeHistory";
import { notifyOpencodeSessionChanged } from "@/transcripts/catalog/opencodeCatalog";
import type { EventMode, TokenUsage } from "@/transcripts/transcriptTypes";

export interface OpencodeSessionLocation {
  sessionId: string;
  projectPath: string;
}

interface OpencodeBackendOptions {
  resolveSession: (sessionId: string) => OpencodeSessionLocation | undefined;
  onSessionCreated: (location: OpencodeSessionLocation) => void;
  onCatalogChanged: () => void;
  /** Overridden in tests so no serve has to run; defaults to this machine's. */
  client?: () => OpencodeClient | null;
  now?: () => number;
}

interface CommandEntry {
  signature: string;
  promise: Promise<AgentCommandReceipt>;
}

interface OwnedSession {
  projection: LiveAgentProjection;
  mapper: OpencodeEventMapper;
  ui: AgentUiBroker;
  subscribers: number;
  lastTouchedAt: number;
  lastRefreshAt: number;
  commandTail: Promise<void>;
  commands: Map<string, CommandEntry>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshQueued: boolean;
  usage: TokenUsage | null;
  disposed: boolean;
}

export const OPENCODE_AGENT_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["nice"],
  canSend: true,
  canSteer: true,
  canAbort: true,
  canFetchRaw: false,
  canOpenTerminal: false,
  supportsExtensionUi: true,
  canStreamLive: false,
};

/** Collapses one burst of serve events into one re-read. */
const REFRESH_COALESCE_MS = 300;
/**
 * How old a projection may be before opening it re-reads the serve.
 *
 * Bounds staleness for polling readers and reconnects. Inside the bound the
 * open path serves memory; outside it pays one round trip.
 */
const FRESHNESS_BOUND_MS = 10_000;

export class OpencodeAgentBackend implements AgentBackend {
  readonly id = "opencode";
  readonly capabilities = OPENCODE_AGENT_CAPABILITIES;

  private readonly owned = new Map<string, OwnedSession>();
  private readonly starts = new Map<string, Promise<OwnedSession>>();
  private readonly creations = new Map<string, { projectPath: string; promise: Promise<AgentSessionDescriptor> }>();
  private readonly now: () => number;
  private readonly serve: () => OpencodeClient | null;
  private readonly events: OpencodeServeEvents;
  private readonly reaper: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: OpencodeBackendOptions) {
    this.now = options.now ?? Date.now;
    this.serve = options.client ?? opencodeClient;
    this.events = new OpencodeServeEvents(
      {
        refresh: (sessionId) => this.scheduleRefresh(sessionId),
        setRunState: (sessionId, state) => this.setRunState(sessionId, state),
        catalogChanged: () => this.options.onCatalogChanged(),
        hasSession: (sessionId) => this.owned.has(sessionId),
        uiFor: (sessionId) => this.owned.get(sessionId)?.ui ?? null,
      },
      this.serve,
    );
    const idleMs = config.opencodeIdleMs;
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(30_000, idleMs));
    this.reaper.unref?.();
  }

  async createSession(requestId: string, projectPath: string): Promise<AgentSessionDescriptor> {
    this.assertActive();
    const prior = this.creations.get(requestId);
    if (prior) {
      if (prior.projectPath !== projectPath) {
        throw new AgentCommandConflictError(`requestId "${requestId}" was reused for another project`);
      }
      return prior.promise;
    }
    const promise = this.createServeSession(projectPath);
    this.creations.set(requestId, { projectPath, promise });
    while (this.creations.size > 128) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      this.creations.delete(oldest);
    }
    return promise;
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
      capabilities: this.capabilities,
    };
  }

  /** Latest occupancy the backend has seen, for the timeline's meter. */
  sessionUsage(sessionId: string): TokenUsage | null {
    return this.owned.get(sessionId)?.usage ?? null;
  }

  async page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage> {
    if (mode !== "nice") throw new AgentModeUnsupportedError("opencode sessions serve nice mode only");
    const owned = await this.open(sessionId);
    owned.lastTouchedAt = this.now();
    const snapshot = owned.projection.snapshot(offset, limit);
    return {
      events: snapshot.events,
      total: snapshot.total,
      mode: "nice",
      sequence: snapshot.sequence,
      runState: snapshot.runState,
      queue: snapshot.queue,
    };
  }

  async subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (envelope: TimelineEnvelope) => void,
  ): Promise<() => void> {
    const owned = await this.open(sessionId);
    owned.subscribers += 1;
    owned.lastTouchedAt = this.now();
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

  async send(
    sessionId: string,
    requestId: string,
    text: string,
    delivery: AgentMessageDelivery,
    attachments: readonly AgentMessageAttachment[] = [],
  ): Promise<AgentCommandReceipt> {
    const owned = await this.open(sessionId);
    const signature = JSON.stringify({ type: "send", text, delivery, attachments: attachments.length });
    return this.command(owned, requestId, signature, async () => {
      // Steer and queue are the serve's own deliveries, not two panel
      // inventions: a steer interrupts the turn with this prompt, a queued
      // prompt waits behind it. Idle sends travel as queued prompts.
      const serveDelivery = delivery === "steer" ? "steer" : "queue";
      const files = attachments.length > 0 ? await stageOpencodeAttachments(sessionId, requestId, attachments) : undefined;
      const answered = await serveRequest(`/api/session/${sessionId}/prompt`, {
        text,
        delivery: serveDelivery,
        ...(files ? { files } : {}),
      });
      if (answered.status === 401) {
        resetOpencodeClient();
        throw new Error(`prompt: unauthorized (${answered.status})`);
      }
      if (answered.status < 200 || answered.status >= 300) {
        throw new Error(`prompt: serve answered ${answered.status} ${answered.text}`);
      }
      if (delivery === "steer") return { requestId, delivery: "steer" };
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  async abort(sessionId: string, requestId: string): Promise<AgentCommandReceipt> {
    const owned = await this.open(sessionId);
    return this.command(owned, requestId, "abort", async () => {
      // Idle interruption is a no-op on the serve side, so aborting a quiet
      // session is safe rather than an error to avoid.
      const interrupted = await this.requireClient().v2.session.interrupt({ sessionID: sessionId });
      if (interrupted.error) throw new Error(`interrupt: ${describeServeError(interrupted.error)}`);
      return { requestId, delivery: "abort" };
    });
  }

  async respondToUi(sessionId: string, requestId: string, value: unknown): Promise<AgentUiResponseResult> {
    return (await this.open(sessionId)).ui.respond(requestId, value);
  }

  async subscribeUi(sessionId: string, listener: (event: AgentUiEvent) => void): Promise<() => void> {
    return (await this.open(sessionId)).ui.subscribe(listener);
  }

  async reapIdle(now = this.now()): Promise<void> {
    for (const [sessionId, owned] of this.owned) {
      if (owned.disposed || owned.subscribers > 0) continue;
      if (owned.projection.runState === "running") continue;
      if (now - owned.lastTouchedAt < config.opencodeIdleMs) continue;
      this.owned.delete(sessionId);
      this.disposeOwned(owned);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);
    await this.events.dispose();
    for (const owned of this.owned.values()) this.disposeOwned(owned);
    this.owned.clear();
    this.starts.clear();
    this.creations.clear();
  }

  private async createServeSession(projectPath: string): Promise<AgentSessionDescriptor> {
    const response = await this.requireClient().v2.session.create({ location: { directory: projectPath } });
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
      capabilities: this.capabilities,
    };
  }

  private async open(sessionId: string): Promise<OwnedSession> {
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
      usage: null,
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
   * still move. The mapper upserts by message id either way, so concurrent
   * refreshes and event bursts converge rather than interleave.
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
      const result = current.mapper.sync(messages);
      const session = info.data?.data;
      if (session?.tokens && session.model) {
        const tokens = session.tokens;
        current.usage = {
          current: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
          limit: null,
          updatedAt: this.now(),
          model: `${session.model.providerID}/${session.model.id}`,
        };
      }
      current.projection.setState(result.open ? "running" : "idle");
      current.lastTouchedAt = this.now();
      current.lastRefreshAt = current.lastTouchedAt;
      notifyOpencodeSessionChanged(sessionId);
    } catch (error) {
      if (isServeUnauthorized(error)) resetOpencodeClient();
      console.error("opencode session refresh failed", { sessionId, error: String(error) });
    }
  }

  private scheduleRefresh(sessionId: string): void {
    const owned = this.owned.get(sessionId);
    if (!owned || owned.disposed || owned.refreshTimer) return;
    owned.refreshTimer = setTimeout(() => {
      if (owned.refreshTimer) {
        owned.refreshTimer = null;
        void this.refresh(sessionId, false);
      }
    }, REFRESH_COALESCE_MS);
    owned.refreshTimer.unref?.();
  }

  private hasSubscribers(): boolean {
    for (const owned of this.owned.values()) {
      if (owned.subscribers > 0) return true;
    }
    return false;
  }

  private setRunState(sessionId: string, state: OpencodeRunState): void {
    const owned = this.owned.get(sessionId);
    if (owned && !owned.disposed) {
      owned.projection.setState(state);
      owned.lastTouchedAt = this.now();
    }
  }

  private command(
    owned: OwnedSession,
    requestId: string,
    signature: string,
    execute: () => Promise<AgentCommandReceipt>,
  ): Promise<AgentCommandReceipt> {
    const prior = owned.commands.get(requestId);
    if (prior) {
      if (prior.signature !== signature) {
        throw new AgentCommandConflictError(`requestId "${requestId}" was reused with another command`);
      }
      return prior.promise;
    }
    const promise = owned.commandTail.then(execute);
    owned.commandTail = promise.then(() => {}, () => {});
    owned.commands.set(requestId, { signature, promise });
    while (owned.commands.size > 128) {
      const oldest = owned.commands.keys().next().value;
      if (oldest === undefined) break;
      owned.commands.delete(oldest);
    }
    owned.lastTouchedAt = this.now();
    return promise;
  }

  private requireClient(): OpencodeClient {
    const client = this.serve();
    if (!client) throw new Error("opencode serve password is not configured");
    return client;
  }

  private assertActive(): void {
    if (this.disposed) throw new AgentBackendDisposedError("opencode agent backend is disposed");
  }

  private disposeOwned(owned: OwnedSession): void {
    if (owned.disposed) return;
    owned.disposed = true;
    if (owned.refreshTimer) clearTimeout(owned.refreshTimer);
    owned.refreshTimer = null;
    owned.ui.dispose();
  }
}
