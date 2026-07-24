/**
 * BridgeDataSource -- AgentDataSource implementation for the iPhone webview.
 *
 * The Swift host pushes messages over the QUIC input lane; the native WKWebView
 * container (wired in a later task) forwards each one by calling
 * `window.__agentFeedDeliver(msg)`. This class routes inbound messages to the
 * right per-session or global listeners, and posts outbound request messages
 * back to the host through the HostBridge.
 *
 * ## Pull / push impedance (fetchEventsPage)
 *
 * The `AgentDataSource` interface exposes a pull API (`fetchEventsPage`) that
 * the existing `useSessionEventsStream` hook calls twice at startup:
 *   1. Probe: (sessionId, 0, 1) -- learns total.
 *   2. Seed:  (sessionId, offset, limit) -- fetches the last page of events.
 *
 * The bridge is purely push: the host sends chunks after a subscription
 * request, not in response to a direct fetch. We bridge the gap with per-session
 * buffering:
 *
 *   - `subscribeSessionEvents` posts `agent-thread-sub` and the host immediately
 *     pushes a seed chunk (isLive: false) containing the tail window.
 *   - `fetchEventsPage` for a not-yet-seeded session posts its own internal
 *     `agent-thread-sub` and awaits the first chunk.
 *   - `fetchEventsPage` for an already-seeded session resolves synchronously
 *     from the buffer.
 *   - For an older page (offset < buffered windowStart), `fetchEventsPage`
 *     posts `agent-thread-older` and waits for the matching chunk
 *     (isLive: false). The wait is bounded by `olderPageTimeoutMs` (default
 *     10s) so a partial or missing older chunk rejects the promise instead of
 *     hanging, and an `agent-thread-error` mid-request rejects it too.
 *
 * Call `destroy()` on teardown (the native container does this on webview
 * re-create) to remove this instance's bridge callback and reject any pending
 * waiters, so the bridge's module-level callback set does not leak.
 *
 * The hook always awaits both fetchEventsPage calls before calling
 * subscribeSessionEvents, so the internal sub is gone (or reused) by the time
 * the live stream starts.
 *
 * ## tp -> type mapping
 *
 * WireActivityEvent uses `tp` instead of `type` to avoid shadowing the top-level
 * message discriminator `t`. This file maps `tp` -> `type` in every place that
 * converts a WireActivityEvent to an ActivityEvent.
 */

import type { ActivityEvent, ActivityBlock } from "../useSessionEventsStream";
import { normalizeActivityEvent } from "../activityNormalization";
import type {
  AgentDataSource,
  EventsPage,
  SessionEventsHandlers,
  SessionsHandlers,
} from "./AgentDataSource";
import type { HostBridge } from "./HostBridge";

// ---------------------------------------------------------------------------
// Wire types (mirror of SharedTypes.swift, bridge input)
// ---------------------------------------------------------------------------

// These mirror the Codable CodingKeys in host/AgentDeskHost/SharedTypes.swift,
// which abbreviate every wire key for compactness (`pp`, `sid`, `tp`, ...). The
// native client forwards the host's JSON verbatim into the webview, so this
// layer must speak those exact abbreviated keys. The full-named app types
// (ActivityEvent, BridgeProject, ...) are produced by the map* helpers below;
// only this wire layer is abbreviated. Keep these in lockstep with the Swift
// CodingKeys -- a drift here silently breaks every push (see the round-trip
// contract test in BridgeDataSource.test.ts).

/** Wire ActivityBlock (Swift `ActivityBlock`): k/lb/tx/tl/sm/pv/ci. */
interface WireActivityBlock {
  k: string; // kind
  lb?: string; // label
  tx?: string; // text
  tl?: string; // tool
  sm?: string; // summary
  pv?: string; // preview
  ci?: string; // callId
}

/** Wire ActivityEvent (Swift `ActivityEvent`): i/ts/tp/b. `tp` is the event
 *  type, mapped to `type` on ActivityEvent. */
interface WireActivityEvent {
  i: number; // index
  ts: number; // timestamp
  tp: string; // type, normalized at runtime for forward compatibility
  b: WireActivityBlock[]; // blocks
}

interface WireThreadChunk {
  t: "agent-thread-chunk";
  sid: string; // sessionId
  ev: WireActivityEvent[]; // events
  ws: number; // windowStart
  tot: number; // total
  lv: boolean; // isLive
}

interface WireThreadError {
  t: "agent-thread-error";
  sid: string; // sessionId
  r: string; // reason
}

interface WireProjectsMessage {
  t: "agent-projects";
  p: WireProjectDigest[]; // projects
}

interface WireProjectDigest {
  pp: string; // projectPath
  dn?: string; // displayName
  ss: WireSessionSummary[]; // sessions
}

interface WireSessionSummary {
  sid: string; // sessionId
  src: "claude" | "codex"; // source
  ttl?: string; // title
  lea: number; // lastEventAt
  lv: boolean; // isLive
}

interface WireAgentTerminalContext {
  pp: string;
  src: "claude" | "codex";
  sid: string;
}

interface WireAgentTerminalReady {
  t: "agent-terminal-ready";
  rid: string;
  ctx: WireAgentTerminalContext;
  psn: string;
}

interface WireAgentTerminalError {
  t: "agent-terminal-error";
  rid: string;
  ctx: WireAgentTerminalContext;
  c: string;
}

interface WireAgentTerminalEnded {
  t: "agent-terminal-ended";
  rid: string;
  ctx: WireAgentTerminalContext;
  psn: string;
  xs?: number;
}

interface WireRawEvent {
  t: "agent-raw-event";
  rid: string;
  sid: string;
  ei: number;
  tx: string;
}

interface WireRawEventError {
  t: "agent-raw-event-error";
  rid: string;
  sid: string;
  ei: number;
  r: string;
}

type InboundMessage =
  | WireThreadChunk
  | WireThreadError
  | WireProjectsMessage
  | WireAgentTerminalReady
  | WireAgentTerminalError
  | WireAgentTerminalEnded
  | WireRawEvent
  | WireRawEventError
  | { t: string };

// ---------------------------------------------------------------------------
// Phone-specific public types (not on AgentDataSource)
// ---------------------------------------------------------------------------

export interface BridgeSessionSummary {
  sessionId: string;
  source: "claude" | "codex";
  title?: string;
  lastEventAt: number;
  isLive: boolean;
}

export interface BridgeProject {
  projectPath: string;
  displayName?: string;
  sessions: BridgeSessionSummary[];
}

export interface AgentTerminalContext {
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

export interface AgentTerminalRequest {
  requestId: string;
  context: AgentTerminalContext;
}

export type AgentTerminalStatus =
  | (AgentTerminalRequest & { kind: "ready"; ptySessionName: string })
  | (AgentTerminalRequest & { kind: "error"; code: string })
  | (AgentTerminalRequest & {
      kind: "ended";
      ptySessionName: string;
      exitStatus?: number;
    });

interface BridgeDataSourceOptions {
  olderPageTimeoutMs?: number;
  rawEventTimeoutMs?: number;
  terminalRequestIDFactory?: () => string;
  rawRequestIDFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Internal per-session buffer
// ---------------------------------------------------------------------------

interface SessionBuffer {
  /** Events received so far, keyed by index. */
  events: Map<number, ActivityEvent>;
  /** Total event count reported by the host. */
  total: number;
  /** Lowest index present in the buffer (from the first chunk's windowStart). */
  windowStart: number;
  /** True once at least one chunk has been delivered for this session. */
  seeded: boolean;
}

/** A pending older-page request waiting for its matching chunk. */
interface OlderWaiter {
  sessionId: string;
  resolve: (chunk: WireThreadChunk) => void;
  reject: (err: Error) => void;
  /** Timeout handle; cleared when the chunk lands or the waiter is rejected. */
  timer: ReturnType<typeof setTimeout>;
}

interface RawEventWaiter {
  sessionId: string;
  eventIndex: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Helper: map WireActivityEvent -> ActivityEvent
// ---------------------------------------------------------------------------

function mapBlock(wire: WireActivityBlock): ActivityBlock {
  // Abbreviated wire keys -> full-named ActivityBlock. The wire omits the
  // fields the sidecar does not send over the bridge (input, hiddenChars,
  // hiddenLines); they stay undefined and the renderer tolerates that.
  return {
    kind: wire.k as ActivityBlock["kind"],
    label: wire.lb,
    text: wire.tx,
    tool: wire.tl,
    summary: wire.sm,
    preview: wire.pv,
    callId: wire.ci,
  };
}

function mapEvent(wire: WireActivityEvent): ActivityEvent {
  return normalizeActivityEvent({
    index: wire.i,
    ts: wire.ts,
    type: wire.tp,
    blocks: wire.b.map(mapBlock),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let fallbackTerminalRequestSequence = 0;

function createTerminalRequestID(): string {
  try {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const value = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `terminal-${value}`;
    }
  } catch {
    // A custom-scheme webview may expose an unusable partial Crypto object.
  }

  fallbackTerminalRequestSequence += 1;
  return `terminal-${Date.now().toString(36)}-${fallbackTerminalRequestSequence.toString(36)}`;
}

function mapTerminalContext(value: unknown): AgentTerminalContext | null {
  if (!isRecord(value)) return null;
  const projectPath = value.pp;
  const source = value.src;
  const sessionId = value.sid;
  if (
    typeof projectPath !== "string" ||
    projectPath.length === 0 ||
    (source !== "claude" && source !== "codex") ||
    typeof sessionId !== "string" ||
    sessionId.length === 0
  ) {
    return null;
  }
  return { projectPath, source, sessionId };
}

function wireTerminalContext(context: AgentTerminalContext): WireAgentTerminalContext {
  return {
    pp: context.projectPath,
    src: context.source,
    sid: context.sessionId,
  };
}

function sameTerminalRequest(
  lhs: AgentTerminalRequest,
  rhs: AgentTerminalRequest,
): boolean {
  return (
    lhs.requestId === rhs.requestId &&
    lhs.context.projectPath === rhs.context.projectPath &&
    lhs.context.source === rhs.context.source &&
    lhs.context.sessionId === rhs.context.sessionId
  );
}

// ---------------------------------------------------------------------------
// BridgeDataSource
// ---------------------------------------------------------------------------

export class BridgeDataSource implements AgentDataSource {
  private readonly _bridge: HostBridge;

  /** Per-session event buffer. */
  private readonly _sessions = new Map<string, SessionBuffer>();

  /** Live onEvent / onError listeners, keyed by sessionId. */
  private readonly _liveListeners = new Map<
    string,
    Set<Pick<SessionEventsHandlers, "onEvent" | "onError">>
  >();

  /** Promises awaiting the first chunk for a session. */
  private readonly _seedWaiters = new Map<
    string,
    Array<(buf: SessionBuffer) => void>
  >();

  /**
   * Promises awaiting an older chunk for a session.
   * Key: `${sessionId}:${beforeIndex}` (beforeIndex = offset+limit from the
   * agent-thread-older request). Each waiter carries `sessionId` (so a
   * thread-error or destroy can reject every waiter for a session without
   * re-deriving keys) and a `timer` handle so the timeout can be cleared
   * once the matching chunk arrives.
   */
  private readonly _olderWaiters = new Map<string, OlderWaiter[]>();
  private readonly _rawEventWaiters = new Map<string, RawEventWaiter>();

  /** Callbacks for agent-projects messages. */
  private readonly _projectsListeners = new Set<
    (projects: BridgeProject[]) => void
  >();

  private readonly _terminalStatusListeners = new Set<
    (status: AgentTerminalStatus) => void
  >();

  private readonly _terminalRequestIDFactory: () => string;
  private readonly _rawRequestIDFactory: () => string;
  private _activeTerminalRequest: AgentTerminalRequest | null = null;

  private _unsubscribeHostMessages: (() => void) | null = null;
  private _destroyed = false;

  /** How long an older-page request waits for its chunk before rejecting. */
  private readonly _olderPageTimeoutMs: number;
  private readonly _rawEventTimeoutMs: number;

  constructor(bridge: HostBridge, opts: BridgeDataSourceOptions = {}) {
    this._bridge = bridge;
    this._olderPageTimeoutMs = opts.olderPageTimeoutMs ?? 10_000;
    this._rawEventTimeoutMs = opts.rawEventTimeoutMs ?? 35_000;
    this._terminalRequestIDFactory =
      opts.terminalRequestIDFactory ?? createTerminalRequestID;
    this._rawRequestIDFactory =
      opts.rawRequestIDFactory ?? createTerminalRequestID;
    this._unsubscribeHostMessages = bridge.onHostMessage((raw) => {
      this._handleInbound(raw as InboundMessage);
    });
  }

  // -------------------------------------------------------------------------
  // AgentDataSource: fetchEventsPage
  // -------------------------------------------------------------------------

  /**
   * Pull adaptation over the push bridge.
   *
   * The hook calls this with (sessionId, 0, 1) as a probe, then again with
   * the seed window. We handle three cases:
   *
   * 1. Already seeded from a prior subscribeSessionEvents call: resolve from
   *    the buffer immediately.
   * 2. Not yet seeded: post agent-thread-sub ourselves and await the first
   *    chunk. The hook's subsequent subscribeSessionEvents call will find the
   *    session already seeded and just register its live listener.
   * 3. Older page (offset below buffered windowStart): post agent-thread-older
   *    and await the matching chunk.
   */
  fetchEventsPage(
    sessionId: string,
    offset: number,
    limit: number,
  ): Promise<EventsPage> {
    const buf = this._sessions.get(sessionId);

    // Case 3: request for events older than the current buffer window.
    if (buf?.seeded && offset < buf.windowStart) {
      const beforeIndex = offset + limit;
      return this._fetchOlderPage(sessionId, beforeIndex, limit);
    }

    // Case 1: already seeded -- resolve from buffer.
    if (buf?.seeded) {
      return Promise.resolve(this._pageFromBuffer(buf, offset, limit));
    }

    // Case 2: not yet seeded. Subscribe and await the first chunk.
    if (!buf) {
      // Create the buffer entry so duplicate internal subs are no-ops.
      this._sessions.set(sessionId, {
        events: new Map(),
        total: 0,
        windowStart: 0,
        seeded: false,
      });
      // Post the subscription request to wake the host.
      this._bridge.postToHost({ t: "agent-thread-sub", sid: sessionId });
    }

    return new Promise<EventsPage>((resolve) => {
      const waiters = this._seedWaiters.get(sessionId) ?? [];
      waiters.push((seededBuf) => {
        resolve(this._pageFromBuffer(seededBuf, offset, limit));
      });
      this._seedWaiters.set(sessionId, waiters);
    });
  }

  // -------------------------------------------------------------------------
  // AgentDataSource: subscribeSessionEvents
  // -------------------------------------------------------------------------

  subscribeSessionEvents(
    sessionId: string,
    _after: number,
    handlers: SessionEventsHandlers,
  ): () => void {
    // Register the live listener.
    if (!this._liveListeners.has(sessionId)) {
      this._liveListeners.set(sessionId, new Set());
    }
    this._liveListeners.get(sessionId)!.add(handlers);

    // Subscribe to the host only if we have not already done so internally.
    const buf = this._sessions.get(sessionId);
    if (!buf) {
      this._sessions.set(sessionId, {
        events: new Map(),
        total: 0,
        windowStart: 0,
        seeded: false,
      });
      this._bridge.postToHost({ t: "agent-thread-sub", sid: sessionId });
    }
    // If buf exists but not seeded, the internal sub from fetchEventsPage
    // already posted agent-thread-sub; no duplicate needed.

    handlers.onOpen?.();

    return () => {
      this._liveListeners.get(sessionId)?.delete(handlers);
      this._bridge.postToHost({ t: "agent-thread-unsub", sid: sessionId });
    };
  }

  // -------------------------------------------------------------------------
  // AgentDataSource: subscribeSessions
  // -------------------------------------------------------------------------

  /**
   * The phone bridge does not support the desktop session rail. This method
   * is a deliberate no-op: it immediately signals "live" with an empty list
   * so callers that have already been wired to AgentDataSource do not hang.
   * The phone-specific project list comes from `subscribeProjects` instead.
   */
  subscribeSessions(handlers: SessionsHandlers): () => void {
    handlers.onLink("live");
    handlers.onSessions([]);
    return () => {
      // nothing to tear down
    };
  }

  fetchRawEvent(sessionId: string, eventIndex: number): Promise<string> {
    if (this._destroyed) return Promise.reject(new Error("BridgeDataSource destroyed"));
    const requestId = this._rawRequestIDFactory();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rawEventWaiters.delete(requestId);
        reject(new Error(`raw event request timed out for ${sessionId} event ${eventIndex}`));
      }, this._rawEventTimeoutMs);
      this._rawEventWaiters.set(requestId, {
        sessionId,
        eventIndex,
        resolve,
        reject,
        timer,
      });
      this._bridge.postToHost({
        t: "agent-raw-event-get",
        rid: requestId,
        sid: sessionId,
        ei: eventIndex,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Phone-specific: subscribeProjects
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the host's agent-projects feed. Posts `agent-projects-sub`
   * once and calls `onProjects` whenever the host pushes an `agent-projects`
   * message. Returns an unsubscribe function.
   *
   * This method is NOT on `AgentDataSource` -- it is phone-specific and must
   * be called through the concrete `BridgeDataSource` type.
   */
  subscribeProjects(onProjects: (projects: BridgeProject[]) => void): () => void {
    this._projectsListeners.add(onProjects);
    // Always (re-)request on subscribe. The host answers every agent-projects-sub
    // with a full snapshot, so re-posting is idempotent and lets a fresh mount
    // recover an initial round-trip that was lost before the lane was attached.
    this.requestProjects();
    return () => {
      this._projectsListeners.delete(onProjects);
    };
  }

  /**
   * Post a fresh `agent-projects-sub` to the host. The host replies with a full
   * `agent-projects` snapshot every time, so this is safe to call repeatedly --
   * it is how a caller retries or manually refreshes after a lost initial
   * subscribe (input lane not yet attached, or the host's reply arriving before
   * the webview bridge was installed) without recreating the webview.
   */
  requestProjects(): void {
    if (this._destroyed) return;
    this._bridge.postToHost({ t: "agent-projects-sub" });
  }

  createTerminalRequest(context: AgentTerminalContext): AgentTerminalRequest {
    return { requestId: this._terminalRequestIDFactory(), context };
  }

  openTerminal(request: AgentTerminalRequest): void {
    if (this._destroyed) return;
    if (
      this._activeTerminalRequest &&
      !sameTerminalRequest(this._activeTerminalRequest, request)
    ) {
      this.endTerminalContext(this._activeTerminalRequest);
    }
    this._activeTerminalRequest = request;
    this._postTerminalIntent("agent-terminal-open", request);
  }

  closeTerminal(request: AgentTerminalRequest): void {
    if (this._destroyed) return;
    this._postTerminalIntent("agent-terminal-close", request);
  }

  endTerminalContext(request: AgentTerminalRequest): void {
    if (this._destroyed) return;
    this._postTerminalIntent("agent-terminal-context-ended", request);
    if (
      this._activeTerminalRequest &&
      sameTerminalRequest(this._activeTerminalRequest, request)
    ) {
      this._activeTerminalRequest = null;
    }
  }

  endActiveTerminalContext(): void {
    if (this._activeTerminalRequest) {
      this.endTerminalContext(this._activeTerminalRequest);
    }
  }

  subscribeTerminalStatus(
    listener: (status: AgentTerminalStatus) => void,
  ): () => void {
    this._terminalStatusListeners.add(listener);
    return () => this._terminalStatusListeners.delete(listener);
  }

  private _postTerminalIntent(
    tag:
      | "agent-terminal-open"
      | "agent-terminal-close"
      | "agent-terminal-context-ended",
    request: AgentTerminalRequest,
  ): void {
    this._bridge.postToHost({
      t: tag,
      rid: request.requestId,
      ctx: wireTerminalContext(request.context),
    });
  }

  // -------------------------------------------------------------------------
  // Inbound message routing
  // -------------------------------------------------------------------------

  private _handleInbound(msg: InboundMessage): void {
    if (this._destroyed) return;
    switch (msg.t) {
      case "agent-thread-chunk":
        this._handleChunk(msg as WireThreadChunk);
        break;
      case "agent-thread-error":
        this._handleThreadError(msg as WireThreadError);
        break;
      case "agent-projects":
        this._handleProjects(msg as WireProjectsMessage);
        break;
      case "agent-terminal-ready":
      case "agent-terminal-error":
      case "agent-terminal-ended":
        this._handleTerminalStatus(msg);
        break;
      case "agent-raw-event":
      case "agent-raw-event-error":
        this._handleRawEvent(msg as WireRawEvent | WireRawEventError);
        break;
      default:
        // Unknown message type; ignore.
        break;
    }
  }

  private _handleChunk(chunk: WireThreadChunk): void {
    const {
      sid: sessionId,
      ev: wireEvents,
      ws: windowStart,
      tot: total,
      lv: isLive,
    } = chunk;

    // Ensure buffer exists.
    let buf = this._sessions.get(sessionId);
    if (!buf) {
      buf = { events: new Map(), total: 0, windowStart, seeded: false };
      this._sessions.set(sessionId, buf);
    }

    // Convert and merge events.
    const mapped: ActivityEvent[] = [];
    for (const wire of wireEvents) {
      const ev = mapEvent(wire);
      buf.events.set(ev.index, ev);
      mapped.push(ev);
    }
    buf.total = Math.max(buf.total, total);
    if (!buf.seeded) {
      buf.windowStart = windowStart;
    } else {
      buf.windowStart = Math.min(buf.windowStart, windowStart);
    }

    if (!isLive) {
      // This is a historical (seed or older) chunk.
      if (!buf.seeded) {
        // Mark seeded and resolve all seed waiters.
        buf.seeded = true;
        const waiters = this._seedWaiters.get(sessionId);
        if (waiters) {
          this._seedWaiters.delete(sessionId);
          for (const resolve of waiters) resolve(buf);
        }
      } else {
        // Older page: resolve any waiting older-page promises.
        // The key is `${sessionId}:${chunk.windowStart + chunk.events.length}`
        // which equals beforeIndex (offset + limit) from the request.
        const beforeIndex = windowStart + wireEvents.length;
        const key = `${sessionId}:${beforeIndex}`;
        const olderWaiters = this._olderWaiters.get(key);
        if (olderWaiters) {
          this._olderWaiters.delete(key);
          for (const w of olderWaiters) {
            clearTimeout(w.timer);
            w.resolve(chunk);
          }
        }
      }
      return;
    }

    // isLive: true -- mark seeded (if not already) and deliver to live listeners.
    if (!buf.seeded) {
      buf.seeded = true;
      const waiters = this._seedWaiters.get(sessionId);
      if (waiters) {
        this._seedWaiters.delete(sessionId);
        for (const resolve of waiters) resolve(buf);
      }
    }

    const listeners = this._liveListeners.get(sessionId);
    if (listeners) {
      for (const ev of mapped) {
        for (const handler of listeners) {
          handler.onEvent(ev);
        }
      }
    }
  }

  private _handleThreadError(msg: WireThreadError): void {
    const sessionId = msg.sid;
    const listeners = this._liveListeners.get(sessionId);
    if (listeners) {
      for (const handler of listeners) {
        handler.onError?.();
      }
    }
    // Also reject any pending seed waiters so they don't hang.
    // We resolve them with an empty page (the caller will see total:0 and
    // treat it as an error or empty session).
    const seedWaiters = this._seedWaiters.get(sessionId);
    if (seedWaiters) {
      this._seedWaiters.delete(sessionId);
      const emptyBuf: SessionBuffer = {
        events: new Map(),
        total: 0,
        windowStart: 0,
        seeded: true,
      };
      for (const resolve of seedWaiters) resolve(emptyBuf);
    }

    // Reject any pending older-page waiters for this session so a thread error
    // mid-request does not leave fetchEventsPage hanging. Older waiters are
    // keyed by `${sessionId}:${beforeIndex}`, so match on the sessionId prefix.
    this._rejectOlderWaiters(
      (w) => w.sessionId === sessionId,
      new Error(`agent-thread-error: ${msg.r}`),
    );
  }

  /**
   * Reject and remove every older-page waiter matching `predicate`, clearing
   * its timeout. Used by thread-error handling and by destroy().
   */
  private _rejectOlderWaiters(
    predicate: (w: OlderWaiter) => boolean,
    err: Error,
  ): void {
    for (const [key, waiters] of this._olderWaiters) {
      const remaining: OlderWaiter[] = [];
      for (const w of waiters) {
        if (predicate(w)) {
          clearTimeout(w.timer);
          w.reject(err);
        } else {
          remaining.push(w);
        }
      }
      if (remaining.length === 0) {
        this._olderWaiters.delete(key);
      } else {
        this._olderWaiters.set(key, remaining);
      }
    }
  }

  private _handleProjects(msg: WireProjectsMessage): void {
    const projects: BridgeProject[] = msg.p.map((p) => ({
      projectPath: p.pp,
      displayName: p.dn,
      sessions: p.ss.map((s) => ({
        sessionId: s.sid,
        source: s.src,
        title: s.ttl,
        lastEventAt: s.lea,
        isLive: s.lv,
      })),
    }));
    for (const cb of this._projectsListeners) {
      cb(projects);
    }
  }

  private _handleRawEvent(msg: WireRawEvent | WireRawEventError): void {
    const waiter = this._rawEventWaiters.get(msg.rid);
    if (!waiter) return;
    if (waiter.sessionId !== msg.sid || waiter.eventIndex !== msg.ei) {
      return;
    }
    this._rawEventWaiters.delete(msg.rid);
    clearTimeout(waiter.timer);
    if (msg.t === "agent-raw-event-error") {
      waiter.reject(new Error(msg.r));
    } else {
      waiter.resolve(msg.tx);
    }
  }

  private _handleTerminalStatus(msg: InboundMessage): void {
    const value = msg as Record<string, unknown>;
    const requestId = value.rid;
    const context = mapTerminalContext(value.ctx);
    if (typeof requestId !== "string" || requestId.length === 0 || !context) {
      return;
    }

    let status: AgentTerminalStatus;
    if (value.t === "agent-terminal-ready") {
      if (typeof value.psn !== "string" || value.psn.length === 0) return;
      status = {
        kind: "ready",
        requestId,
        context,
        ptySessionName: value.psn,
      };
    } else if (value.t === "agent-terminal-error") {
      if (typeof value.c !== "string" || value.c.length === 0) return;
      status = { kind: "error", requestId, context, code: value.c };
    } else if (value.t === "agent-terminal-ended") {
      if (typeof value.psn !== "string" || value.psn.length === 0) return;
      if (value.xs !== undefined && typeof value.xs !== "number") return;
      status = {
        kind: "ended",
        requestId,
        context,
        ptySessionName: value.psn,
        exitStatus: value.xs as number | undefined,
      };
    } else {
      return;
    }

    for (const listener of this._terminalStatusListeners) {
      listener(status);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _pageFromBuffer(
    buf: SessionBuffer,
    offset: number,
    limit: number,
  ): EventsPage {
    const all = Array.from(buf.events.values()).sort(
      (a, b) => a.index - b.index,
    );
    const slice = all.filter(
      (ev) => ev.index >= offset && ev.index < offset + limit,
    );
    return { events: slice, total: buf.total };
  }

  private _fetchOlderPage(
    sessionId: string,
    beforeIndex: number,
    limit: number,
  ): Promise<EventsPage> {
    this._bridge.postToHost({
      t: "agent-thread-older",
      sid: sessionId,
      bi: beforeIndex,
      lim: limit,
    });

    const key = `${sessionId}:${beforeIndex}`;
    return new Promise<EventsPage>((resolve, reject) => {
      // Bounded wait: a partial or missing older chunk (whose windowStart +
      // length does not match beforeIndex) would otherwise never resolve this
      // promise. After the timeout we reject and drop the waiter.
      const timer = setTimeout(() => {
        this._rejectOlderWaiters(
          (cand) => cand === waiter,
          new Error(
            `agent-thread-older timed out for ${sessionId} (beforeIndex ${beforeIndex})`,
          ),
        );
      }, this._olderPageTimeoutMs);

      const waiter: OlderWaiter = {
        sessionId,
        timer,
        reject,
        resolve: (chunk) => {
          const buf = this._sessions.get(sessionId);
          resolve(
            this._pageFromBuffer(
              buf ?? {
                events: new Map(),
                total: chunk.tot,
                windowStart: chunk.ws,
                seeded: true,
              },
              chunk.ws,
              chunk.ev.length,
            ),
          );
        },
      };

      const waiters = this._olderWaiters.get(key) ?? [];
      waiters.push(waiter);
      this._olderWaiters.set(key, waiters);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Tear down this data source. The native WKWebView container calls this on
   * webview teardown so the bridge's module-level callback set does not leak
   * across webview re-creates.
   *
   * - Removes this instance's host-message callback from the bridge.
   * - Rejects every pending older-page waiter (clearing its timer).
   * - Resolves pending seed waiters with an empty page so awaiters do not hang.
   * - Clears all per-session state, live listeners, and projects listeners.
   *
   * After destroy() the instance ignores further inbound messages.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    this._unsubscribeHostMessages?.();
    this._unsubscribeHostMessages = null;

    // Reject every pending older-page waiter.
    this._rejectOlderWaiters(() => true, new Error("BridgeDataSource destroyed"));
    this._olderWaiters.clear();

    for (const waiter of this._rawEventWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("BridgeDataSource destroyed"));
    }
    this._rawEventWaiters.clear();

    // Resolve pending seed waiters with an empty page so callers unblock.
    for (const [, waiters] of this._seedWaiters) {
      const emptyBuf: SessionBuffer = {
        events: new Map(),
        total: 0,
        windowStart: 0,
        seeded: true,
      };
      for (const resolve of waiters) resolve(emptyBuf);
    }
    this._seedWaiters.clear();

    this._sessions.clear();
    this._liveListeners.clear();
    this._projectsListeners.clear();
    this._terminalStatusListeners.clear();
    this._activeTerminalRequest = null;
  }
}
