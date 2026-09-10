// What the catalog publishes about projects and sessions, and what a session can do.

import type { EventMode, SourceId } from "./activity.ts";

// How recently a session was active, derived at read time rather than stored:
// a selected-project probe combines transcript recency with the latest bounded
// turn signal.
export type Bin = 'live' | 'ready' | 'paused' | 'cold';

export type AgentRunState = "idle" | "running" | "ended" | "error";

export interface AgentQueueState {
  steer: number;
  followUp: number;
}

export interface AgentSessionCapabilities {
  modes: EventMode[];
  canSend: boolean;
  canSteer: boolean;
  canAbort: boolean;
  canFetchRaw: boolean;
  canOpenTerminal: boolean;
  supportsExtensionUi: boolean;
  /** True when the session has a live, network-observed delta stream (claude live source). */
  canStreamLive: boolean;
}

export interface ProjectSummary {
  projectPath: string;
  displayName: string;
  sourceCounts: Record<string, number>;
  sessionCount: number;
  lastEventAt: number;
}

export interface SessionSummary {
  sessionId: string;
  source: SourceId;
  title: string;
  lastEventAt: number;
  activity: Bin;
  capabilities: AgentSessionCapabilities;
  /**
   * The git worktree this session is working in, when that is not the directory it is listed under.
   *
   * Present only where it changes what a row means. A Bot is bound to one directory and now accepts
   * sessions from worktrees of it, so two rows on one Bot can be editing two branches of one
   * repository -- and without this they are indistinguishable, which is a worse failure than the
   * refusal that used to stand in its place.
   *
   * `branch` is null for a detached worktree, which is a real state rather than an error: a
   * worktree checked out at a commit belongs to its repository and has no branch to name.
   */
  worktree?: { path: string; branch: string | null };
}
