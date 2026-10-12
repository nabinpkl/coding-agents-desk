// Owning this machine's opencode sessions through its serve, the way the Pi
// backend owns its runtimes: page and subscribe from a per-session projection,
// send and abort as correlated commands, permissions and questions through the
// shared UI broker.
//
// Session lifetimes live one layer down, in `opencodeSessionPool.ts`: opening,
// adopting, refreshing and reaping all edit the same maps, so they share one
// owner rather than two sharers. This class issues commands and answers queries
// against the sessions the pool hands back. Creating one is here rather than there: it is a
// single remote call that owns none of the pool's state, and the session is the pool's only
// from its first `open`.
//
// What it deliberately does NOT do: spawn a server (`createOpencode()` is
// never constructed -- the user already runs one serve per machine), read the
// serve's SQLite (the API is the record), or track stream ids. Live updates
// arrive as serve events and each one schedules a coalesced re-read of that
// session's messages, so there is no delta to lose and no orphan to drop; the
// projection dedupes unchanged rows by content.
//
// Everything travels the serve's `/api` family, through the serve's own client
// (`@opencode/client`, pinned to the serve's release) or a raw call beside it.
// The root paths serve the web UI's HTML in `--service` mode, so they are never
// called: a 200 text/html where JSON was expected is what a wrong family looks
// like, and it was measured before this comment existed.

import { isServeUnauthorized, opencodeClient, resetOpencodeClient, serveRequest, type OpencodeClient } from "@/agents/opencode/opencodeClient";
import { stageOpencodeAttachments, listOpencodeServeCommands, listOpencodeModels, switchOpencodeModel, compactOpencodeSession, lastOpencodeUserMessage, undoOpencodeSession, redoOpencodeSession, renameOpencodeSession, forkOpencodeSession, askOpencodeAside, exportOpencodeSession, LOCAL_OPENCODE_COMMANDS, type OpencodeSlashCommand, type OpencodeModel } from "@/agents/opencode/opencodeServeCalls";
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
import type { TimelineEnvelope } from "@/agents/liveAgentProjection";
import type { TokenUsage, EventMode } from "@/transcripts/transcriptTypes";
import { OpencodeSessionPool, type OpencodePoolOptions, type OpencodeSessionLocation, type OwnedSession } from "@/agents/opencode/opencodeSessionPool";

export type { OpencodeSessionLocation } from "@/agents/opencode/opencodeSessionPool";

export interface OpencodeBackendOptions extends Omit<OpencodePoolOptions, "capabilities"> {}

/** One serve permission rule. Of those matching an action and resource, the last decides. */
export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

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
  canOpenTerminal: true,
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

  /**
   * `permissions` are session-scoped rules, read after the agent's with the last match winning,
   * and held from the session's first moment because they ride the create itself.
   */
  async createSession(
    requestId: string,
    projectPath: string,
    options: { permissions?: readonly OpencodePermissionRule[] } = {},
  ): Promise<AgentSessionDescriptor> {
    this.assertActive();
    const prior = this.creations.get(requestId);
    if (prior) {
      if (prior.projectPath !== projectPath) {
        throw new AgentCommandConflictError(`requestId "${requestId}" was reused for another project`);
      }
      return prior.promise;
    }
    const promise = this.createOnServe(projectPath, options.permissions);
    this.creations.set(requestId, { projectPath, promise });
    while (this.creations.size > 128) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      this.creations.delete(oldest);
    }
    return promise;
  }

  private async createOnServe(
    projectPath: string,
    permissions: readonly OpencodePermissionRule[] | undefined,
  ): Promise<AgentSessionDescriptor> {
    const client = this.serve();
    if (!client) throw new Error("opencode serve password is not configured");
    const created = await client.session.create({
      location: { directory: projectPath },
      ...(permissions ? { permissions } : {}),
    });
    if (typeof created.id !== "string" || !created.id) throw new Error("opencode created a session without an id");
    // Rules that did not arrive leave a session running as its agent, which is everything the
    // rules were there to refuse. The old client dropped this very field without an error, so
    // the stored rules are checked against the asked-for ones, and a mismatch removes the
    // session before anything can use it rather than handing it on unconfined.
    if (permissions && !sameRules(created.permissions, permissions)) {
      await client.session.remove({ sessionID: created.id }).catch(() => {});
      throw new Error("opencode created the session without the rules it was asked to hold");
    }
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

  describeSession(sessionId: string): AgentSessionDescriptor | undefined {
    if (this.disposed) return undefined;
    return this.pool.describeSession(sessionId);
  }

  /** Latest occupancy the pool has seen, for the timeline's meter. */
  sessionUsage(sessionId: string): TokenUsage | null {
    return this.pool.sessionUsage(sessionId);
  }

  /**
   * The bytes behind one of the session's image blocks, for the image route's on-demand read.
   * Null where the session holds no picture there; the row draws without it.
   */
  opencodeImage(
    sessionId: string,
    eventIndex: number,
    blockIndex: number,
  ): { mediaType: string; data: string } | null {
    if (this.disposed) return null;
    return this.pool.imageFor(sessionId, eventIndex, blockIndex);
  }

  /**
   * The session's current model as `providerID/modelID`, for the switcher. Delegated so the
   * timeline route's probe lands: it survives the post-compaction gap that blanks usage.
   */
  sessionModel(sessionId: string): string | null {
    return this.pool.sessionModel(sessionId);
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
      await this.requireClient().session.interrupt({ sessionID: sessionId });
      return { requestId, delivery: "abort" };
    });
  }

  /** What this serve offers after a slash; listing needs no session, only a live backend. */
  async listCommands(): Promise<OpencodeSlashCommand[]> {
    this.assertActive();
    // Server commands first, panel-run commands after: the picker shows one list, and the names
    // never collide because the serve answers CommandNotFound for ours (measured).
    return [...(await listOpencodeServeCommands()), ...LOCAL_OPENCODE_COMMANDS];
  }

  /**
   * Whether a typed name is one this backend runs natively, or null for a serve command. Names
   * only: the panel resolves an alias to its catalogue name before it sends one, so a second
   * alias table here would be a second answer to the same question.
   */
  private isLocalCommand(name: string): boolean {
    return LOCAL_OPENCODE_COMMANDS.some((command) => command.name === name);
  }

  /**
   * `/btw`: one answer from the session's own context, adding nothing to the conversation.
   *
   * Its own route rather than a command receipt because it starts no turn -- there is nothing to
   * correlate -- and because the answer is the whole payload.
   */
  async askAside(sessionId: string, question: string): Promise<string> {
    this.assertActive();
    this.requireKnownSession(sessionId);
    return askOpencodeAside(sessionId, question);
  }

  /** `/export`: the projected transcript, whole, as the web client writes it to a file. */
  async exportTranscript(sessionId: string): Promise<unknown> {
    this.assertActive();
    this.requireKnownSession(sessionId);
    return exportOpencodeSession(sessionId);
  }

  /**
   * Renames the session, which is what the panel's Rename dialog asks for.
   *
   * Its own door rather than the command route's `/rename`, for the reason the reads have one: a
   * title is not a turn. The command route opens the session to run against, so renaming through
   * it would adopt an idle session -- subscribe to its thread, connect its hub stream -- to change
   * a label. This checks the registry and leaves it alone.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.assertActive();
    this.requireKnownSession(sessionId);
    await this.applyRename(sessionId, title);
  }

  /**
   * The one rename, shared with `/rename` so the dialog and the command cannot drift.
   *
   * The catalog is told rather than left to hear about it, because the serve does not say:
   * measured on a live serve, the PATCH answers 204 and no `session.updated` event follows it, so
   * the new title reached no row until the 30s reconcile backstop -- a rename that reads as one
   * that did nothing. The caller made the change, so the caller is the event.
   */
  private async applyRename(sessionId: string, title: string): Promise<void> {
    const named = title.trim();
    if (!named) throw new Error("rename needs a title after the name");
    await renameOpencodeSession(sessionId, named);
    this.options.onCatalogChanged();
  }

  /**
   * A session this machine knows about, checked against the registry rather than opened through
   * the pool: a read asks about a session that may hold no turn at all, and adopting one to read a
   * tail is work neither of these needs.
   */
  private requireKnownSession(sessionId: string): void {
    if (!this.options.resolveSession(sessionId)) {
      throw new AgentSessionNotFoundError(`opencode session "${sessionId}" was not found`);
    }
  }

  /** Every model the serve offers, for the picker. Read-only, so no ledger. */
  async listModels(): Promise<OpencodeModel[]> {
    this.assertActive();
    return listOpencodeModels();
  }

  /**
   * Switches the session's model, on the serve that holds it. The panel's meter reads the model
   * back off this session's own projection, so it moves on that session's next read rather than on
   * this call.
   */
  async switchModel(sessionId: string, requestId: string, providerID: string, modelID: string): Promise<AgentCommandReceipt> {
    const owned = await this.pool.open(sessionId);
    const signature = JSON.stringify({ type: "switch-model", providerID, modelID });
    return this.command(owned, requestId, signature, async () => {
      await switchOpencodeModel(sessionId, providerID, modelID);
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  /**
   * Runs a panel-run slash op natively: compact, undo, redo, rename, fork. These never appear
   * in the serve's own command list (measured: it carries only the custom commands plus init and
   * review), so the run route sorts them here instead of at the serve's command endpoint. Unknown
   * names are refused rather than prompted, because a typo reaching the model reads as a literal
   * slash.
   *
   * `/fork` is the one that answers with more than a receipt: it makes a session, and the panel
   * has to be told which one to open. `/btw` and `/export` are NOT here -- they read rather than
   * change, they start no turn, and what they answer with is the payload, so each is its own
   * route (`askAside`, `exportTranscript`) rather than a receipt nobody can carry a transcript in.
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
          await this.requireClient().session.interrupt({ sessionID: sessionId });
        }
        const messageId = await lastOpencodeUserMessage(sessionId);
        if (!messageId) throw new Error("nothing to undo");
        await undoOpencodeSession(sessionId, messageId);
      } else if (name === "redo") {
        // The mirror of undo, and it needs no target: what undo left staged is what redo drops.
        await redoOpencodeSession(sessionId);
      } else if (name === "rename") {
        await this.applyRename(sessionId, text);
      } else if (name === "fork") {
        const location = this.options.resolveSession(sessionId);
        if (!location) throw new AgentSessionNotFoundError(`opencode session "${sessionId}" was not found`);
        const forked = await forkOpencodeSession(sessionId);
        this.options.onSessionCreated({ sessionId: forked.sessionId, projectPath: location.projectPath });
        return {
          requestId,
          delivery: owned.projection.runState === "idle" ? "immediate" : "followUp",
          session: {
            sessionId: forked.sessionId,
            source: "opencode",
            projectPath: location.projectPath,
            title: forked.title,
            lastEventAt: this.now(),
            activity: "ready",
            capabilities: this.capabilities,
          },
        };
      } else {
        throw new Error(`unknown local command "${name}"`);
      }
      return { requestId, delivery: owned.projection.runState === "idle" ? "immediate" : "followUp" };
    });
  }

  /** Runs one slash command natively: prompt text starting with `/name` reads literally (measured), so only this route expands the template. The flat `{ name, text }` shape is this serve's own -- the pinned SDK sends `{ command, arguments }` and is refused. Panel-run names sort to their native implementations here rather than at the route, so the route never learns the distinction. */
  async runCommand(sessionId: string, requestId: string, name: string, text: string): Promise<AgentCommandReceipt> {
    if (this.isLocalCommand(name)) {
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

/** The same rules in the same order: order is meaning here, since the last match decides. */
function sameRules(
  stored: readonly OpencodePermissionRule[] | undefined,
  asked: readonly OpencodePermissionRule[],
): boolean {
  if (!stored || stored.length !== asked.length) return false;
  return stored.every((rule, index) => {
    const other = asked[index];
    return rule.action === other?.action && rule.resource === other.resource && rule.effect === other.effect;
  });
}
