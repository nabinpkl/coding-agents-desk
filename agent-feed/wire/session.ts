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
}
