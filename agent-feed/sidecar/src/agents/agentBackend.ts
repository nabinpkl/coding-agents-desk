import type { ActivityEvent, EventMode } from "@/transcripts/sources/transcriptTypes";
import type { AgentRunState, AgentQueueState, TimelineEnvelope } from "@/agents/liveAgentProjection";
import type {
  AgentCommandReceipt,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentUiEvent,
} from "@agentdesk/agent-feed-wire";

// Everything a backend publishes about itself, or that a command answers with,
// crosses the HTTP boundary unchanged, so it is declared once in agent-feed/wire
// and re-exported here. What stays local is what never leaves this process: the
// backend interface, its error classes, and the page shape the HTTP layer
// decorates before publishing.
export type {
  AgentCommandReceipt,
  AgentSessionCapabilities,
  AgentSessionDescriptor,
  AgentUiEvent,
  AgentUiRequest,
  AgentUiRequestKind,
} from "@agentdesk/agent-feed-wire";

export interface AgentTimelinePage {
  events: ActivityEvent[];
  total: number;
  mode: EventMode;
  sequence: number;
  runState: AgentRunState;
  queue: AgentQueueState;
}

export type AgentMessageDelivery = "next" | "steer";

export type AgentUiResponseResult = "accepted" | "already-resolved" | "not-found" | "invalid";

/** A session-id referenced a session this backend does not own (or that has been dropped). */
export class AgentSessionNotFoundError extends Error {}
/** A mode the backend does not serve was requested (e.g. `raw` on a nice-only live source). */
export class AgentModeUnsupportedError extends Error {}
/** A command's request-id/signature conflicts with an in-flight command. */
export class AgentCommandConflictError extends Error {}
/** The backend has been disposed; no further commands are accepted. */
export class AgentBackendDisposedError extends Error {}

export interface AgentBackend {
  readonly id: string;
  readonly capabilities: AgentSessionCapabilities;
  describeSession(sessionId: string): AgentSessionDescriptor | undefined;
  createSession(requestId: string, projectPath: string): Promise<AgentSessionDescriptor>;
  page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage>;
  subscribe(sessionId: string, afterSequence: number, listener: (envelope: TimelineEnvelope) => void): Promise<() => void>;
  send(sessionId: string, requestId: string, text: string, delivery: AgentMessageDelivery): Promise<AgentCommandReceipt>;
  abort(sessionId: string, requestId: string): Promise<AgentCommandReceipt>;
  subscribeUi(sessionId: string, listener: (event: AgentUiEvent) => void): Promise<() => void>;
  respondToUi(sessionId: string, requestId: string, value: unknown): Promise<AgentUiResponseResult>;
  dispose(): Promise<void>;
}

export class AgentBackendRegistry {
  private readonly backends = new Map<string, AgentBackend>();

  register(backend: AgentBackend): void {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(backend.id)) {
      throw new Error(`invalid agent backend id "${backend.id}"`);
    }
    if (this.backends.has(backend.id)) throw new Error(`duplicate agent backend "${backend.id}"`);
    this.backends.set(backend.id, backend);
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.backends.values()].map((backend) => backend.dispose()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), "agent backend shutdown failed");
    }
  }
}
