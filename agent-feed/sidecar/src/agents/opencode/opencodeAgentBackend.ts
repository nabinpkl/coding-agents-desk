// Owning this machine's opencode sessions through its serve, the way the Pi
// backend owns its runtimes: page and subscribe from a per-session projection,
// send and abort as correlated commands, permissions and questions through the
// shared UI broker.
//
// Session lifetimes live one layer down, in `opencodeSessionPool.ts`: opening,
// adopting, refreshing and reaping all edit the same maps, so they share one
// owner rather than two sharers. This class issues commands and answers queries
// against the sessions the pool hands back.
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
import { describeServeError, isServeUnauthorized, opencodeClient, resetOpencodeClient, serveRequest } from "@/agents/opencode/opencodeClient";
import { stageOpencodeAttachments, listOpencodeServeCommands, listOpencodeModels, switchOpencodeModel, compactOpencodeSession, lastOpencodeUserMessage, undoOpencodeSession, renameOpencodeSession, LOCAL_OPENCODE_COMMANDS, type OpencodeSlashCommand, type OpencodeModel } from "@/agents/opencode/opencodeServeCalls";
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
} from "@/agents/agentBackend";
import type { TimelineEnvelope } from "@/agents/liveAgentProjection";
import type { TokenUsage, EventMode } from "@/transcripts/transcriptTypes";
import { OpencodeSessionPool, type OpencodePoolOptions, type OpencodeSessionLocation, type OwnedSession } from "@/agents/opencode/opencodeSessionPool";

export type { OpencodeSessionLocation } from "@/agents/opencode/opencodeSessionPool";

export interface OpencodeBackendOptions extends Omit<OpencodePoolOptions, "capabilities"> {}

interface CommandEntry {
  signature: string;
  promise: Promise<AgentCommandReceipt>;
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

export class OpencodeAgentBackend implements AgentBackend {
  readonly id = "opencode";
  readonly capabilities = OPENCODE_AGENT_CAPABILITIES;

  private readonly creations = new Map<string, { projectPath: string; promise: Promise<AgentSessionDescriptor> }>();
  private readonly now: () => number;
  private readonly serve: () => OpencodeClient | null;
  private readonly pool: OpencodeSessionPool;
  private disposed = false;

  constructor(private readonly options: OpencodeBackendOptions) {
    this.now = options.now ?? Date.now;
    this.serve = options.client ?? opencodeClient;
    this.pool = new OpencodeSessionPool({ ...options, capabilities: this.capabilities });
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
    const promise = this.pool.create(projectPath);
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
    return this.pool.describeSession(sessionId);
  }

  /** Latest occupancy the pool has seen, for the timeline's meter. */
  sessionUsage(sessionId: string): TokenUsage | null {
    return this.pool.sessionUsage(sessionId);
  }

  /**
   * What the session's summariser has streamed so far, or null when it is not compacting.
   * Delegated so the timeline route's probe lands: only this backend's sessions compact.
   */
  compactionSummary(sessionId: string): string | null {
    return this.pool.compactionSummary(sessionId);
  }

  onCompaction(listener: (sessionId: string, active: boolean) => void): () => void {
    return this.pool.onCompaction(listener);
  }

  onCompactionSummary(
    listener: (sessionId: string, text: string, replace: boolean) => void,
  ): () => void {
    return this.pool.onCompactionSummary(listener);
  }

  async page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage> {
    if (mode !== "nice") throw new AgentModeUnsupportedError("opencode sessions serve nice mode only");
    return this.pool.page(sessionId, offset, limit, mode);
  }

  async subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (envelope: TimelineEnvelope) => void,
  ): Promise<() => void> {
    return this.pool.subscribe(sessionId, afterSequence, listener);
  }

  async send(
    sessionId: string,
    requestId: string,
    text: string,
    delivery: AgentMessageDelivery,
    attachments: readonly AgentMessageAttachment[] = [],
  ): Promise<AgentCommandReceipt> {
    const owned = await this.pool.open(sessionId);
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
    const owned = await this.pool.open(sessionId);
    return this.command(owned, requestId, "abort", async () => {
      // Idle interruption is a no-op on the serve side, so aborting a quiet
      // session is safe rather than an error to avoid.
      const interrupted = await this.requireClient().v2.session.interrupt({ sessionID: sessionId });
      if (interrupted.error) throw new Error(`interrupt: ${describeServeError(interrupted.error)}`);
      return { requestId, delivery: "abort" };
    });
  }

  /** What this serve offers after a slash; listing needs no session, only a live backend. */
  async listCommands(): Promise<OpencodeSlashCommand[]> {
    this.assertActive();
    // Server commands first, TUI-local ops after: the picker shows one list, and the names
    // never collide because the serve answers CommandNotFound for the local ones (measured).
    return [...(await listOpencodeServeCommands()), ...LOCAL_OPENCODE_COMMANDS];
  }

  /** Every model the serve offers, for the picker. Read-only, so no ledger. */
  async listModels(): Promise<OpencodeModel[]> {
    this.assertActive();
    return listOpencodeModels();
  }

  /** Switches the session's model; the change lands on the session event like a rename. */
  async switchModel(sessionId: string, requestId: string, providerID: string, modelID: string): Promise<AgentCommandReceipt> {
    const owned = await this.pool.open(sessionId);
    const signature = JSON.stringify({ type: "switch-model", providerID, modelID });
    return this.command(owned, requestId, signature, async () => {
      await switchOpencodeModel(sessionId, providerID, modelID);
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  /**
   * Runs a TUI-local slash op natively: compact, undo, rename. These never appear in the
   * server command list (measured: it carries only custom commands and init/review), so the
   * run route sorts them here instead of at the serve's command endpoint. Unknown names are
   * refused rather than prompted, because a typo reaching the model reads as a literal slash.
   */
  async runLocalCommand(sessionId: string, requestId: string, name: string, text: string): Promise<AgentCommandReceipt> {
    const owned = await this.pool.open(sessionId);
    const signature = JSON.stringify({ type: "local-command", name, text });
    return this.command(owned, requestId, signature, async () => {
      if (name === "compact") {
        await compactOpencodeSession(sessionId);
      } else if (name === "undo") {
        // The TUI's own order: stop the turn first, then revert what it was answering.
        if (owned.projection.runState !== "idle") {
          const interrupted = await this.requireClient().v2.session.interrupt({ sessionID: sessionId });
          if (interrupted.error) throw new Error(`interrupt: ${describeServeError(interrupted.error)}`);
        }
        const messageId = await lastOpencodeUserMessage(sessionId);
        if (!messageId) throw new Error("nothing to undo");
        await undoOpencodeSession(sessionId, messageId);
      } else if (name === "rename") {
        const title = text.trim();
        if (!title) throw new Error("rename needs a title after the name");
        await renameOpencodeSession(sessionId, title);
      } else {
        throw new Error(`unknown local command "${name}"`);
      }
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  /** Runs one slash command natively: prompt text starting with `/name` reads literally (measured), so only this route expands the template. The flat `{ name, text }` shape is this serve's own -- the pinned SDK sends `{ command, arguments }` and is refused. TUI-local names sort to their native implementations here rather than at the route, so the route never learns the distinction. */
  async runCommand(sessionId: string, requestId: string, name: string, text: string): Promise<AgentCommandReceipt> {
    if (LOCAL_OPENCODE_COMMANDS.some((command) => command.name === name)) {
      return this.runLocalCommand(sessionId, requestId, name, text);
    }
    const owned = await this.pool.open(sessionId);
    const signature = JSON.stringify({ type: "command", name, text });
    return this.command(owned, requestId, signature, async () => {
      const answered = await serveRequest(`/api/session/${sessionId}/command`, { name, text });
      if (answered.status === 401) {
        resetOpencodeClient();
        throw new Error(`command: unauthorized (${answered.status})`);
      }
      if (answered.status < 200 || answered.status >= 300) {
        throw new Error(`command: serve answered ${answered.status} ${answered.text}`);
      }
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  async respondToUi(sessionId: string, requestId: string, value: unknown): Promise<AgentUiResponseResult> {
    return (await this.pool.open(sessionId)).ui.respond(requestId, value);
  }

  async subscribeUi(sessionId: string, listener: (event: AgentUiEvent) => void): Promise<() => void> {
    return (await this.pool.open(sessionId)).ui.subscribe(listener);
  }

  async reapIdle(now = this.now()): Promise<void> {
    this.pool.reapIdle(now);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.creations.clear();
    await this.pool.dispose();
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
