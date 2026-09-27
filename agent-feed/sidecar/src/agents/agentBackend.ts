import type { ActivityEvent, EventMode } from "@/transcripts/transcriptTypes";
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

/**
 * A backend that names its sessions' current model, as `providerID/modelID`. Probed rather
 * than required: only opencode's backend names one, and Pi implements neither this nor usage.
 */
export type ModelReportingBackend = AgentBackend & {
  sessionModel(sessionId: string): string | null;
};

/**
 * The session's model stamped onto a page or envelope, or nothing to spread where no backend
 * has named one. One helper because both timeline routes probe the same optional method, and
 * absent-while-unknown keeps a sender that never names a model byte-identical to before.
 */
export function stampSessionModel(
  backend: AgentBackend,
  sessionId: string,
): { sessionModel: string } | Record<string, never> {
  const reporting = backend as ModelReportingBackend;
  const model = typeof reporting.sessionModel === "function"
    ? reporting.sessionModel(sessionId)
    : null;
  return model === null ? {} : { sessionModel: model };
}

/** A session-id referenced a session this backend does not own (or that has been dropped). */
export class AgentSessionNotFoundError extends Error {}
/** A mode the backend does not serve was requested (e.g. `raw` on a nice-only live source). */
export class AgentModeUnsupportedError extends Error {}
/** A command's request-id/signature conflicts with an in-flight command. */
export class AgentCommandConflictError extends Error {}
/** The backend has been disposed; no further commands are accepted. */
export class AgentBackendDisposedError extends Error {}

/**
 * One image riding a send: bytes as base64, because the route body is JSON.
 *
 * Carried rather than referenced by path because the panel holds Blobs, not files -- the bytes
 * cross here, and the backend writes them where its serve can read them. Opencode-only: its
 * prompt takes file URIs, while Pi has no image path and the route refuses attachments there.
 */
export interface AgentMessageAttachment {
  data: string;
  mime: string;
  name: string;
}

const MAXIMUM_SEND_FILES = 5;
const MAXIMUM_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Images riding a send, validated where the contract lives: refusal is a 400 about the
 * request, not a 500 about the command. Five files, 8 MiB decoded each: a phone photo
 * passes, a video does not, and the route's own body cap bounds their sum.
 */
export function parseMessageAttachments(value: unknown): AgentMessageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("files must be an array");
  if (value.length > MAXIMUM_SEND_FILES) throw new Error(`at most ${MAXIMUM_SEND_FILES} files ride one send`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("each file needs data, mime and name");
    const record = entry as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data : "";
    const mime = typeof record.mime === "string" ? record.mime : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data) || data.length === 0) throw new Error("each file needs base64 data");
    if (!mime.startsWith("image/") || mime.length > 128) throw new Error("each file must be an image");
    if (!name.trim() || name.length > 128) throw new Error("each file needs a name");
    const decodedBytes = Math.floor((data.length * 3) / 4);
    if (decodedBytes > MAXIMUM_ATTACHMENT_BYTES) throw new Error(`"${name}" exceeds 8 MiB`);
    return { data, mime, name };
  });
}

export interface AgentBackend {
  readonly id: string;
  readonly capabilities: AgentSessionCapabilities;
  describeSession(sessionId: string): AgentSessionDescriptor | undefined;
  createSession(requestId: string, projectPath: string): Promise<AgentSessionDescriptor>;
  page(sessionId: string, offset: number, limit: number, mode: EventMode): Promise<AgentTimelinePage>;
  subscribe(sessionId: string, afterSequence: number, listener: (envelope: TimelineEnvelope) => void): Promise<() => void>;
  send(sessionId: string, requestId: string, text: string, delivery: AgentMessageDelivery, attachments?: readonly AgentMessageAttachment[]): Promise<AgentCommandReceipt>;
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
