// The response bodies of the agent-feed HTTP API, and the SSE messages its streams emit.
//
// Every one of these travels verbatim: the host relay attaches an Authorization header and copies
// bytes, so what the sidecar writes here is exactly what the panel parses.

import type { ActivityEvent, EventMode, TokenUsage } from "./activity.ts";
import type {
  AgentQueueState,
  AgentRunState,
  AgentSessionCapabilities,
  Bin,
  ProjectSummary,
  SessionSummary,
} from "./session.ts";

/**
 * A surface's whole inventory arrives on one stream:
 * `GET /api/inventory/stream?projectPath=<a>&projectPath=<b>`.
 *
 * The project list rides it unconditionally; each requested project's session list
 * rides it too. A message is one or the other, told apart by which key it carries.
 * `projectPath` repeats rather than joining on a separator, because these are
 * filesystem paths.
 */
export interface ProjectsPayload {
  projects: ProjectSummary[];
}

/** An inventory-stream message, and the body of `GET /api/sessions?projectPath=`. */
export interface SessionsPayload {
  projectPath: string;
  sessions: SessionSummary[];
}

/** `GET /api/sessions/{source}/{sessionId}/events?offset=&limit=&mode=`. */
export interface EventsPage {
  events: ActivityEvent[];
  /** Counted in `mode`, so the panel's paging arithmetic is in the same units as the indices. */
  total: number;
  mode: EventMode;
  usage: TokenUsage | null;
  sequence: number;
  runState: AgentRunState;
  queue: AgentQueueState;
}

/**
 * One message of a timeline stream.
 *
 * `snapshot` replaces the visible window authoritatively; `upsert` appends or revises within it;
 * `state` carries run/queue movement with no events. Runtime-local indices and revisions cannot be
 * merged across a snapshot boundary, which is why the kind is on the wire rather than inferred.
 */
export interface TimelineEnvelope {
  kind: "snapshot" | "upsert" | "state";
  sequence: number;
  mode: EventMode;
  events: ActivityEvent[];
  windowStart: number;
  total: number;
  runState: AgentRunState;
  queue: AgentQueueState;
  /**
   * Session occupancy as of this message, not page occupancy.
   *
   * It rides the envelope rather than taking a message type of its own because the stream already
   * fires once per event, so the meter goes live with no extra plumbing.
   */
  usage?: TokenUsage | null;
}

/**
 * One message of `GET /api/sessions/{source}/{sessionId}/timeline?mode=`.
 *
 * The composite subscription. Opening a thread used to mean four coordinated
 * requests -- probe the page count, fetch the last window, follow the durable
 * stream from that window's sequence, and open the live-tail and extension-UI
 * streams if the session's capabilities warranted them -- with whoever opened them
 * responsible for keeping a stale subscription's callbacks from being believed.
 * That is the sidecar's own knowledge (its page size, its sequence numbering, its
 * capability table), so it belongs on one stream the sidecar orchestrates.
 *
 * `timeline` carries the opening window and every later revision of it, discriminated
 * by the envelope's own `kind`. `tail` is the live in-flight message, with `null`
 * meaning the tail is over. `ui` is an extension-UI prompt. `error` is non-fatal
 * unless the stream also ends.
 */
export type TimelineMessage =
  | { type: "timeline"; envelope: TimelineEnvelope }
  | { type: "tail"; event: ActivityEvent | null }
  | { type: "ui"; event: AgentUiEvent }
  | { type: "error"; error: WireErrorPayload["error"] };

/**
 * `POST /api/agent-sessions` (201) -- the created session's descriptor.
 *
 * `source` is a bare string rather than the `SourceId` union: a backend registers itself under a
 * bounded lowercase identifier, and this shape has to name one that predates neither side's build.
 */
export interface AgentSessionDescriptor {
  sessionId: string;
  source: string;
  projectPath: string;
  title: string;
  lastEventAt: number;
  activity: Bin;
  capabilities: AgentSessionCapabilities;
}

/** `POST .../messages` and `POST .../abort` (202). */
export interface AgentCommandReceipt {
  requestId: string;
  delivery: "immediate" | "followUp" | "steer" | "abort";
}

export type AgentUiRequestKind =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "status"
  | "widget";

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

/** Each message of `GET /api/agent-sessions/{source}/{sessionId}/ui/stream`. */
export type AgentUiEvent =
  | { type: "request"; request: AgentUiRequest }
  | { type: "dismiss"; requestId: string };

/**
 * A failure body.
 *
 * `retryable` is the sidecar's own judgement and the panel's only basis for deciding whether to
 * offer a retry: a missing session is terminal, a stream that dropped is not.
 */
export interface WireErrorPayload {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
  };
}

/**
 * A failure delivered INSIDE an SSE stream rather than as a status code.
 *
 * A stream has already sent its 200 by the time most things can go wrong, so this is the only way
 * a live subscription reports one.
 */
export interface WireStreamError {
  error: string | WireErrorPayload["error"];
}
