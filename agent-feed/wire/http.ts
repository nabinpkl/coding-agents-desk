// The response bodies of the agent-feed HTTP API, and the SSE messages its streams emit.
//
// Every one of these travels verbatim: the host relay attaches an Authorization header and copies
// bytes, so what the sidecar writes here is exactly what the panel parses.

import type { ActivityEvent, EventMode, SourceId, TokenUsage } from "./activity.ts";
import type {
  AgentQueueState,
  AgentRunState,
  AgentSessionCapabilities,
  Bin,
  ProjectSummary,
  SessionSummary,
} from "./session.ts";
import type { MachineShellBackend } from "./terminal.ts";
import type { UsageVendorId } from "./usage.ts";

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
  /**
   * The session's current model as `providerID/modelID`.
   *
   * Separate from `usage` on purpose: usage blanks across a post-compaction gap
   * (no turn has reported tokens for the new window yet), while the model survives
   * it -- a compaction rewrites context, never the model. A reader of the model
   * alone must not go through occupancy. Absent while no backend has named one.
   */
  sessionModel?: string | null;
  sequence: number;
  runState: AgentRunState;
  queue: AgentQueueState;
  /**
   * Identity of the runtime projection that produced this page, when the source has one.
   *
   * A transcript-backed page has no projection and omits it. A runtime-backed page names the
   * projection instance so a reconnect can tell "same rows" from "the sidecar rebuilt them".
   */
  projectionId?: string;
}

/**
 * One message of a timeline stream.
 *
 * `snapshot` re-states the visible window authoritatively; `upsert` appends or revises within it;
 * `state` carries run/queue movement with no events. Runtime-local indices and revisions cannot be
 * merged across a snapshot boundary, which is why the kind is on the wire rather than inferred --
 * and `stableIndices` is what says whether THIS session's indices are runtime-local at all.
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
   * Whether an event's index means the same line on every open of this session.
   *
   * True for a session whose durable record is a transcript on disk: lines are only ever appended,
   * so index 5231 is the same line before and after a reconnect, and a snapshot is a WINDOW onto a
   * record the reader may already hold more of. False (or absent, for a sender that predates this
   * field) for a runtime-backed session whose projection renumbers: there the snapshot is a
   * REPLACEMENT and anything the reader still holds is a different session's arithmetic. OpenCode
   * is a declared exception, guarded by `projectionId` when its projection is rebuilt.
   *
   * It exists because the receiver cannot work this out. Both kinds arrive on one stream shape, and
   * the sidecar has already decided which it is -- a source with a transcript adapter and a catalog
   * entry -- before the first byte is written.
   */
  stableIndices?: boolean;
  /**
   * Which runtime projection produced this envelope, when the source has one.
   *
   * `stableIndices` says whether rows may be retained across a reconnect. This says whether the
   * sender is even the same projection: a sidecar restart rebuilds it, so a new id is a
   * replacement boundary even when the source otherwise keeps stable indices.
   */
  projectionId?: string;
  /**
   * Session occupancy as of this message, not page occupancy.
   *
   * It rides the envelope rather than taking a message type of its own because the stream already
   * fires once per event, so the meter goes live with no extra plumbing.
   */
  usage?: TokenUsage | null;
  /**
   * The session's current model as `providerID/modelID`.
   *
   * Beside usage rather than inside it: usage blanks across a post-compaction gap while the
   * model survives it, and the model switcher reads this without touching the meter. Absent
   * while no backend has named one, so a sender that never names a model emits byte-identical
   * envelopes to before.
   */
  sessionModel?: string | null;
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
 * unless the stream also ends. `heartbeat` carries nothing and is sent every
 * `TIMELINE_HEARTBEAT_MS`.
 *
 * `compacting` says the harness is rewriting this session's context right now. Its own message
 * rather than a field on the envelope, because it is the one thing here that is true of a session
 * while no row is arriving: a compaction writes no transcript line until it lands, so there is no
 * envelope to hang it on. Sent when the stream opens if it is already true, carrying the summary
 * written so far, and again on each change; a sender that predates it never sends one, which reads
 * as false.
 *
 * `compaction-summary` is the summariser's text as it streams, beside the thread and never in it:
 * appended to what `compacting` carried, or replacing it when `replace` is set, which is what a
 * retried summariser does. None of it outlives the compaction; the summary that lands is in the
 * transcript.
 */
export type TimelineMessage =
  | { type: "timeline"; envelope: TimelineEnvelope }
  | { type: "tail"; event: ActivityEvent | null }
  | { type: "compacting"; active: boolean; summary?: string }
  | { type: "compaction-summary"; text: string; replace: boolean }
  | { type: "ui"; event: AgentUiEvent }
  | { type: "error"; error: WireErrorPayload["error"] }
  | { type: "heartbeat" };

/**
 * How often the timeline stream says it is still there.
 *
 * A message rather than an SSE comment, because this is the reader's only way to tell a stalled
 * connection from a quiet session: a stream that stops delivering without closing raises no error
 * in `EventSource`, which surfaces neither the stall nor a comment. A thread reader that has heard
 * nothing for several beats reopens the stream, and gets the newest window back as its snapshot.
 */
export const TIMELINE_HEARTBEAT_MS = 15_000;

/**
 * `POST /api/agent-sessions` (201) -- the created session's descriptor.
 *
 * `source` is a bare string rather than the `SourceId` union: a backend registers itself under a
 * bounded lowercase identifier, and this shape has to name one that predates neither side's build.
 */
export interface AgentSessionDescriptor {
  sessionId: string;
  /**
   * A registered source, not an open string: a descriptor is what a Bot's session list is built
   * from, and that list addresses sessions by `SourceId` (`BotSessionRef`).
   */
  source: SourceId;
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
  /**
   * The session a command made rather than drove, which today is only `/fork`. The panel opens
   * it on the canvas, so the answer has to name it: a request id it would have to correlate
   * against a later catalog refresh is a race it has no way to win.
   */
  session?: AgentSessionDescriptor;
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

/**
 * `GET /api/config` -- the sidecar's process-global facts.
 *
 * Declared here late: this body predates the wire module and was the last one still stated only
 * by the route that emits it. The summarizer's availability is the first field on it the panel
 * actually branches on, and a flag whose only definition is a route literal is exactly the drift
 * this module exists to prevent.
 */
export interface SidecarConfig {
  staleThresholdMs: number;
  readyThresholdMs: number;
  liveWindowMs: number;
  watcherState: string;
  sessionCount: number;
  /** False when no model credential is configured; the panel hides Summarize entirely. */
  summaryEnabled: boolean;
  /** `provider/model`, for naming what wrote a digest. Null when disabled. */
  summaryModel: string | null;
  /**
   * Vendors whose local usage records this machine actually has.
   *
   * Empty means the Usage surface is not offered at all, rather than offered and then opening
   * onto nothing. A process-global fact for the same reason `summaryEnabled` is: it describes
   * the machine, not the thread on screen.
   */
  usageVendors: UsageVendorId[];
  /** Whether the Desktop park surface has a window manager to drive. */
  parkAvailable: boolean;
  /**
   * What a machine terminal opens on here: the PTY manager when this machine runs one, tmux when
   * it does not. A peer runs the sidecar without the host that supervises the PTY manager.
   */
  machineShell: MachineShellBackend;
  /**
   * What this machine's sidecar supervisor is holding back, or null when nothing supervises it.
   *
   * Here rather than on a route of its own because it is a fact about the machine, like everything
   * else on this document, and because the panel's dev server already asks every sidecar it knows
   * for `/api/config` on a timer to see whether it is alive. Carrying it on an answer somebody is
   * already waiting for costs no request, and connections are the scarce thing between the panel
   * and a peer.
   *
   * Null on a bundled sidecar, which has no supervisor, and on one whose supervisor stopped
   * heartbeating: a dead supervisor's last words shown as live are worse than saying nothing.
   */
  supervisor: SupervisorStatus | null;
  /**
   * Which code this sidecar is running: a hash of its source and the wire contract, taken as it
   * started (`sidecar/src/sourceVersion.ts`). The panel's dev server hashes its own tree the same
   * way, and a difference is a sidecar behind the panel it is serving.
   */
  sourceVersion: string;
}

/**
 * A sidecar supervisor's view of its own tree.
 *
 * The supervisor runs the sidecar as a child and replaces it only when every changed file parses
 * (`agent-feed/sidecar/src/supervisorGate.ts`), so a sidecar can be deliberately older than the
 * tree beside it. Without this the panel shows a feed that has merely gone quiet.
 */
export interface SupervisorStatus {
  /** True when the tree has moved since the running sidecar was started. */
  held: boolean;
  /** Which file will not parse, and why. Null when nothing is in the way. */
  blocked: string | null;
  /**
   * Whether it replaces the sidecar as soon as the tree parses, or waits to be asked.
   *
   * The second half of the same question the panel's own gate asks. A restart is not free to the
   * reader: every stream the panel holds dies with the process, the desktop encoders go with it,
   * and terminals re-import their scrollback. Measured on this machine 2026-09-15, three restarts
   * inside 32 seconds during one editing burst.
   */
  mode: SupervisorMode;
}

/** Whether a supervisor acts on a change itself, or waits for the reader. */
export type SupervisorMode = "auto" | "manual";

/** Setting a supervisor's mode, or asking it to take the tree it is sitting on. */
export type SupervisorCommand = SupervisorMode | "apply";

/**
 * What `POST /api/supervisor` carries.
 *
 * The sidecar cannot act on this itself: the supervisor is its PARENT, with no port and no way to
 * be called. The sidecar leaves the request on the same board it reads the supervisor's state from
 * and the supervisor picks it up, which is also what lets a panel on another machine set it.
 */
export interface SupervisorCommandRequest {
  command: SupervisorCommand;
}
