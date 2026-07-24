export type SessionSource = "claude" | "codex";

// Snapshot of the model's current context-window occupancy. `current` is the
// number of tokens in the most recent prompt the model processed. Compaction
// is implicit: the post-compaction turn reports a smaller `current` so the
// dashboard meter drops automatically with no special handling.
export interface TokenUsage {
  current: number;
  limit: number | null;
  updatedAt: number;
}

export interface HarnessSession {
  sessionId: string;
  source: SessionSource;
  project: string;
  projectName: string;
  transcriptPath?: string;
  // Whether the most recent turn-boundary signal in the transcript was a
  // terminal marker. Liveness is derived, not stored: combine with
  // lastEventAt recency via liveness.isSessionLive.
  lastTurnClosed: boolean;
  lastEventAt: number;
  lastSnippet: string;
  // Codex-only: human/auto title from Codex's threads index.
  title?: string;
  gitBranch?: string;
  entrypoint?: string;
  tmuxSession?: string;
  tokenUsage?: TokenUsage;
}

export type LinkState = "connecting" | "live" | "reloading" | "offline";
