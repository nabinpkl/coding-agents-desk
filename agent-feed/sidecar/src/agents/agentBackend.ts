import type { ActivityEvent, EventMode } from "../transcripts/sources/transcriptTypes.ts";
import type { AgentRunState, AgentQueueState, TimelineEnvelope } from "./liveAgentProjection.ts";

export interface AgentSessionCapabilities {
  modes: EventMode[];
  canSend: boolean;
  canSteer: boolean;
  canAbort: boolean;
  canFetchRaw: boolean;
  canOpenTerminal: boolean;
  supportsExtensionUi: boolean;
}

export interface AgentSessionDescriptor {
  sessionId: string;
  source: string;
  projectPath: string;
  title: string;
  lastEventAt: number;
  activity: "live" | "ready" | "paused" | "cold";
  capabilities: AgentSessionCapabilities;
}

export interface AgentTimelinePage {
  events: ActivityEvent[];
  total: number;
  mode: EventMode;
  sequence: number;
  runState: AgentRunState;
  queue: AgentQueueState;
}

export type AgentMessageDelivery = "next" | "steer";

export interface AgentCommandReceipt {
  requestId: string;
  delivery: "immediate" | "followUp" | "steer" | "abort";
}

export type AgentUiRequestKind = "select" | "confirm" | "input" | "editor" | "notify" | "status" | "widget";

export interface AgentUiRequest {
  requestId: string;
  kind: AgentUiRequestKind;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  level?: "info" | "warning" | "error";
  key?: string;
  lines?: string[];
  expectsResponse: boolean;
}

export type AgentUiEvent =
  | { type: "request"; request: AgentUiRequest }
  | { type: "dismiss"; requestId: string };

export type AgentUiResponseResult = "accepted" | "already-resolved" | "not-found" | "invalid";

export interface AgentBackend {
  readonly id: string;
  readonly capabilities: AgentSessionCapabilities;
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
