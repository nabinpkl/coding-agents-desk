import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { config } from "../config.ts";
import type { EventMode } from "../transcripts/sources/transcriptTypes.ts";
import {
  type AgentBackend,
  type AgentCommandReceipt,
  type AgentMessageDelivery,
  type AgentSessionCapabilities,
  type AgentSessionDescriptor,
  type AgentTimelinePage,
  type AgentUiEvent,
  type AgentUiResponseResult,
} from "./agentBackend.ts";
import { AgentUiBroker, extensionUiContext } from "./agentUiBroker.ts";
import { LiveAgentProjection, type TimelineEnvelope } from "./liveAgentProjection.ts";
import { PiEventMapper } from "./piEventMapper.ts";

export interface PiSessionLocation {
  sessionId: string;
  projectPath: string;
  transcriptPath: string;
  title: string;
  lastEventAt: number;
}

export interface PiSessionFacade {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: AgentSession["messages"];
  readonly isIdle: boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  bindExtensions(bindings: Parameters<AgentSession["bindExtensions"]>[0]): Promise<void>;
}

export interface PiRuntimeFacade {
  readonly session: PiSessionFacade;
  dispose(): Promise<void>;
}

export type PiRuntimeFactory = (projectPath: string, transcriptPath?: string) => Promise<PiRuntimeFacade>;

interface PiBackendOptions {
  resolveSession: (sessionId: string) => PiSessionLocation | undefined;
  onSessionCreated: (location: PiSessionLocation) => void;
  runtimeFactory?: PiRuntimeFactory;
  idleRuntimeMs?: number;
  toolCallBudget?: number;
  now?: () => number;
}

interface CommandEntry {
  signature: string;
  promise: Promise<AgentCommandReceipt>;
}

interface OwnedRuntime {
  runtime: PiRuntimeFacade;
  projection: LiveAgentProjection;
  mapper: PiEventMapper;
  ui: AgentUiBroker;
  unsubscribeSession: () => void;
  subscribers: number;
  lastTouchedAt: number;
  commandTail: Promise<void>;
  commands: Map<string, CommandEntry>;
  toolCallsThisRun: number;
  disposed: boolean;
}

export class AgentCommandConflictError extends Error {}
export class AgentSessionNotFoundError extends Error {}
export class AgentModeUnsupportedError extends Error {}

export class PiAgentBackend implements AgentBackend {
  readonly id = "pi";
  readonly capabilities: AgentSessionCapabilities = {
    modes: ["nice"],
    canSend: true,
    canSteer: true,
    canAbort: true,
    canFetchRaw: false,
    canOpenTerminal: false,
    supportsExtensionUi: true,
  };

  private readonly owned = new Map<string, OwnedRuntime>();
  private readonly starts = new Map<string, Promise<OwnedRuntime>>();
  private readonly creations = new Map<string, { projectPath: string; promise: Promise<AgentSessionDescriptor> }>();
  private readonly runtimeFactory: PiRuntimeFactory;
  private readonly idleRuntimeMs: number;
  private readonly toolCallBudget: number;
  private readonly now: () => number;
  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(private readonly options: PiBackendOptions) {
    this.runtimeFactory = options.runtimeFactory ?? createOfficialPiRuntime;
    this.idleRuntimeMs = options.idleRuntimeMs ?? config.piIdleRuntimeMs;
    this.toolCallBudget = options.toolCallBudget ?? config.piToolCallBudget;
    this.now = options.now ?? Date.now;
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(30_000, this.idleRuntimeMs));
    this.reaper.unref?.();
  }

  async createSession(requestId: string, projectPath: string): Promise<AgentSessionDescriptor> {
    const prior = this.creations.get(requestId);
    if (prior) {
      if (prior.projectPath !== projectPath) {
        throw new AgentCommandConflictError(`requestId "${requestId}" was reused for another project`);
      }
      return prior.promise;
    }
    const promise = this.createPersistentSession(projectPath);
    this.creations.set(requestId, { projectPath, promise });
    while (this.creations.size > 128) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      this.creations.delete(oldest);
    }
    return promise;
  }

  private async createPersistentSession(projectPath: string): Promise<AgentSessionDescriptor> {
    const runtime = await this.runtimeFactory(projectPath);
    const sessionId = runtime.session.sessionId;
    if (!sessionId || !runtime.session.sessionFile) {
      await runtime.dispose();
      throw new Error("Pi created a session without persistent JSONL identity");
    }
    const owned = await this.adoptRuntime(runtime);
    this.owned.set(sessionId, owned);
    const location: PiSessionLocation = {
      sessionId,
      projectPath,
      transcriptPath: runtime.session.sessionFile,
      title: sessionId,
      lastEventAt: this.now(),
    };
    this.options.onSessionCreated(location);
    return this.descriptor(location, owned);
  }

  async page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage> {
    if (mode !== "nice") throw new AgentModeUnsupportedError("Pi sessions support nice mode only");
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
    const unsubscribe = owned.projection.subscribe(afterSequence, listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      owned.subscribers = Math.max(0, owned.subscribers - 1);
      owned.lastTouchedAt = this.now();
    };
  }

  async send(
    sessionId: string,
    requestId: string,
    text: string,
    delivery: AgentMessageDelivery,
  ): Promise<AgentCommandReceipt> {
    const owned = await this.open(sessionId);
    const signature = JSON.stringify({ type: "send", text, delivery });
    return this.command(owned, requestId, signature, async () => {
      const session = owned.runtime.session;
      if (delivery === "steer") {
        await session.steer(text);
        return { requestId, delivery: "steer" };
      }
      if (session.isIdle) {
        void session.prompt(text).catch((error) => this.recordRuntimeError(owned, error));
        return { requestId, delivery: "immediate" };
      }
      await session.followUp(text);
      return { requestId, delivery: "followUp" };
    });
  }

  async abort(sessionId: string, requestId: string): Promise<AgentCommandReceipt> {
    const owned = await this.open(sessionId);
    return this.command(owned, requestId, "abort", async () => {
      await owned.runtime.session.abort();
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
    const disposals: Promise<void>[] = [];
    for (const [sessionId, owned] of this.owned) {
      if (owned.subscribers > 0 || !owned.runtime.session.isIdle) continue;
      if (now - owned.lastTouchedAt < this.idleRuntimeMs) continue;
      this.owned.delete(sessionId);
      disposals.push(this.disposeOwned(owned));
    }
    await Promise.all(disposals);
  }

  async dispose(): Promise<void> {
    clearInterval(this.reaper);
    const values = [...this.owned.values()];
    this.owned.clear();
    this.starts.clear();
    this.creations.clear();
    await Promise.all(values.map((owned) => this.disposeOwned(owned)));
  }

  private async open(sessionId: string): Promise<OwnedRuntime> {
    const current = this.owned.get(sessionId);
    if (current) return current;
    const pending = this.starts.get(sessionId);
    if (pending) return pending;
    const location = this.options.resolveSession(sessionId);
    if (!location) throw new AgentSessionNotFoundError(`Pi session "${sessionId}" was not found`);
    const start = this.runtimeFactory(location.projectPath, location.transcriptPath)
      .then((runtime) => this.adoptRuntime(runtime))
      .then((owned) => {
        this.owned.set(sessionId, owned);
        return owned;
      })
      .finally(() => this.starts.delete(sessionId));
    this.starts.set(sessionId, start);
    return start;
  }

  private async adoptRuntime(runtime: PiRuntimeFacade): Promise<OwnedRuntime> {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    mapper.seed(runtime.session.messages);
    const ui = new AgentUiBroker();
    const owned: OwnedRuntime = {
      runtime,
      projection,
      mapper,
      ui,
      unsubscribeSession: () => {},
      subscribers: 0,
      lastTouchedAt: this.now(),
      commandTail: Promise.resolve(),
      commands: new Map(),
      toolCallsThisRun: 0,
      disposed: false,
    };
    owned.unsubscribeSession = runtime.session.subscribe((event) => {
      owned.lastTouchedAt = this.now();
      if (event.type === "agent_start") owned.toolCallsThisRun = 0;
      if (event.type === "tool_execution_start") {
        owned.toolCallsThisRun += 1;
        if (owned.toolCallsThisRun > this.toolCallBudget) {
          this.recordRuntimeError(owned, new Error(`tool call budget ${this.toolCallBudget} exceeded`));
          void runtime.session.abort();
          return;
        }
      }
      mapper.accept(event);
    });
    await runtime.session.bindExtensions({
      mode: "rpc",
      uiContext: extensionUiContext(ui),
      onError: (error) => this.recordRuntimeError(owned, error),
    });
    return owned;
  }

  private command(
    owned: OwnedRuntime,
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

  private descriptor(location: PiSessionLocation, owned?: OwnedRuntime): AgentSessionDescriptor {
    return {
      sessionId: location.sessionId,
      source: "pi",
      projectPath: location.projectPath,
      title: location.title,
      lastEventAt: location.lastEventAt,
      activity: owned?.runtime.session.isIdle === false ? "live" : "ready",
      capabilities: this.capabilities,
    };
  }

  private recordRuntimeError(owned: OwnedRuntime, error: unknown): void {
    owned.projection.upsert({
      id: `error:${this.now()}`,
      ts: this.now(),
      type: "system",
      phase: "complete",
      blocks: [{ kind: "metadata", label: "Agent error", text: error instanceof Error ? error.message : String(error) }],
    });
    owned.projection.setState("error");
  }

  private async disposeOwned(owned: OwnedRuntime): Promise<void> {
    if (owned.disposed) return;
    owned.disposed = true;
    owned.unsubscribeSession();
    owned.ui.dispose();
    await owned.runtime.dispose();
  }
}

const officialRuntimeFactory: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd, agentDir: config.piAgentDirectory });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

async function createOfficialPiRuntime(projectPath: string, transcriptPath?: string): Promise<PiRuntimeFacade> {
  const sessionManager = transcriptPath
    ? SessionManager.open(transcriptPath, dirname(transcriptPath), projectPath)
    : SessionManager.create(projectPath, piProjectSessionDirectory(projectPath));
  return createAgentSessionRuntime(officialRuntimeFactory, {
    cwd: projectPath,
    agentDir: config.piAgentDirectory,
    sessionManager,
  });
}

// Pi 0.83.0 does not export its project-directory helper from the package root.
// Keep this byte-for-byte equivalent to the pinned SDK convention so AgentDesk's
// configurable root can still be used by both SessionManager and the catalog.
export function piProjectSessionDirectory(
  projectPath: string,
  sessionsDirectory = config.piSessionsDirectory,
): string {
  const safePath = `--${resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(sessionsDirectory), safePath);
}
