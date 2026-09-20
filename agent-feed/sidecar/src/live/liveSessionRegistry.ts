// Which sessions a read-only live mirror is currently holding, and when it lets one go.
//
// Both live backends observe far more traffic than any reader is watching, so a
// projection is created on the first event for a session and dropped again once
// nothing is subscribed and nothing has arrived for a while. The bound exists for
// the same reason: an unattended sidecar would otherwise accumulate a projection per
// session the harness has ever spoken through.
//
// Shared by the claude and codex backends, which differed only in the vendor word in
// the not-found error, their own idle-drop setting, and whatever per-session state
// they keep outside this registry -- that last one is what `forget` is for.

import { AgentSessionNotFoundError } from "@/agents/agentBackend";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import type { TokenUsage } from "@/transcripts/transcriptTypes";

interface SessionTrack {
  lastEventAt: number;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

export interface LiveSessionRegistryOptions {
  /** The vendor word in the not-found error, so it reads as the backend a caller asked. */
  vendor: string;
  maxSessions: number;
  idleDropMs: number;
  /** Per-session state the backend keeps outside this registry, dropped with the session. */
  forget?: (sessionId: string) => void;
}

export class LiveSessionRegistry {
  private readonly projections = new Map<string, LiveAgentProjection>();
  private readonly tracks = new Map<string, SessionTrack>();
  private readonly subscriberCounts = new Map<string, number>();
  /**
   * The session's most recent token usage. Public because the stream reducers write
   * into it by reference: a mid-turn usage record carries counts without the model
   * name and has to read the name back off what the turn's opening record wrote.
   */
  readonly usage = new Map<string, TokenUsage>();
  /** Told when a session gains a projection. See `onSessionLive`. */
  private readonly sessionLiveListeners = new Set<(sessionId: string) => void>();

  constructor(private readonly options: LiveSessionRegistryOptions) {}

  /** The projection for a session, or nothing if it has never had an event. */
  get(sessionId: string): LiveAgentProjection | undefined {
    return this.projections.get(sessionId);
  }

  require(sessionId: string): LiveAgentProjection {
    const projection = this.projections.get(sessionId);
    if (!projection) {
      throw new AgentSessionNotFoundError(
        `${this.options.vendor} live session "${sessionId}" was not found`,
      );
    }
    return projection;
  }

  lastEventAt(sessionId: string): number {
    return this.tracks.get(sessionId)?.lastEventAt ?? 0;
  }

  /**
   * Told when a session gains a projection, which is the moment it becomes live-capable.
   *
   * A thread stream reads `canStreamLive` once, when its request arrives, so a session that
   * becomes capable afterwards was invisible to every stream already open. This is the event that
   * makes it visible without a reload and without anyone polling to ask.
   *
   * Not on `AgentBackend`: a backend with no live mirror has nothing to announce, and callers
   * probe for this the same way they probe `sessionUsage`.
   */
  onSessionLive(listener: (sessionId: string) => void): () => void {
    this.sessionLiveListeners.add(listener);
    return () => this.sessionLiveListeners.delete(listener);
  }

  ensure(sessionId: string): LiveAgentProjection {
    let projection = this.projections.get(sessionId);
    if (!projection) {
      projection = new LiveAgentProjection();
      this.projections.set(sessionId, projection);
      // Before the bound is enforced, so the session being created is the most recently active one
      // rather than a session with no activity at all, which is what the bound evicts first.
      this.touch(sessionId);
      this.enforceSessionBound();
      this.announceSessionLive(sessionId);
      return projection;
    }
    this.touch(sessionId);
    return projection;
  }

  touch(sessionId: string): void {
    const existing = this.tracks.get(sessionId);
    if (existing?.dropTimer) {
      clearTimeout(existing.dropTimer);
      existing.dropTimer = null;
    }
    this.tracks.set(sessionId, { lastEventAt: Date.now(), dropTimer: existing?.dropTimer ?? null });
  }

  retain(sessionId: string): void {
    this.subscriberCounts.set(sessionId, (this.subscriberCounts.get(sessionId) ?? 0) + 1);
  }

  release(sessionId: string): void {
    const remaining = (this.subscriberCounts.get(sessionId) ?? 1) - 1;
    if (remaining > 0) this.subscriberCounts.set(sessionId, remaining);
    else this.subscriberCounts.delete(sessionId);
  }

  scheduleDrop(sessionId: string): void {
    if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
    const track = this.tracks.get(sessionId);
    if (track?.dropTimer) return;
    const timer = setTimeout(() => {
      if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
      this.projections.delete(sessionId);
      this.tracks.delete(sessionId);
      this.usage.delete(sessionId);
      this.options.forget?.(sessionId);
    }, this.options.idleDropMs);
    timer.unref?.();
    this.tracks.set(sessionId, { lastEventAt: track?.lastEventAt ?? Date.now(), dropTimer: timer });
  }

  /** Drops every timer and every session. Called from the backend's `dispose`. */
  clear(): void {
    for (const track of this.tracks.values()) {
      if (track.dropTimer) clearTimeout(track.dropTimer);
    }
    this.projections.clear();
    this.tracks.clear();
    this.subscriberCounts.clear();
    this.usage.clear();
  }

  private announceSessionLive(sessionId: string): void {
    for (const listener of this.sessionLiveListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        console.error("agent feed session-live listener failed", error);
      }
    }
  }

  private enforceSessionBound(): void {
    while (this.projections.size > this.options.maxSessions) {
      // The least recently active session NOBODY is reading. Both halves matter: `release` deletes
      // a session's entry rather than leaving a zero behind, so a pass that looked for a zero count
      // found none and fell through to the oldest session whatever its readers -- and `dropSession`
      // then refused to evict a session with a reader, leaving the size unchanged and this loop
      // choosing the same victim forever.
      let victim: string | null = null;
      let oldest = Infinity;
      for (const sessionId of this.projections.keys()) {
        if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) continue;
        const lastEventAt = this.tracks.get(sessionId)?.lastEventAt ?? 0;
        if (lastEventAt >= oldest) continue;
        oldest = lastEventAt;
        victim = sessionId;
      }
      // Every projection has a reader: the bound gives way rather than evicting one of them.
      if (victim === null) break;
      this.dropSession(victim);
    }
  }

  private dropSession(sessionId: string): void {
    if ((this.subscriberCounts.get(sessionId) ?? 0) > 0) return;
    this.projections.delete(sessionId);
    this.tracks.delete(sessionId);
    this.usage.delete(sessionId);
    this.options.forget?.(sessionId);
  }
}
