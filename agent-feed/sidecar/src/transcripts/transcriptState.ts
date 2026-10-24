import type { Session } from "@/transcripts/transcriptTypes";

export type WatcherState = "idle" | "reconciling" | "live";

export interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  teardown: () => void;
}

export interface TranscriptState {
  sessions: Map<string, Session>;
  subscribers: Set<(snapshot: Session[]) => void>;
  // Whatever a source needs to stop watching: tree watches costing a handful of descriptors each,
  // the Codex state database's directory among them.
  sourceWatchers: { close(): Promise<void> }[];
  discoveryTimer: ReturnType<typeof setInterval> | null;
  watcherState: WatcherState;
  /**
   * What shutdown has to stop beyond the transcript sources: long-lived loops the process started
   * itself, such as the opencode hub adapter's streams. Each is a synchronous stop; the shutdown
   * path runs them in order and reports one that throws rather than swallowing it.
   */
  shutdownHooks: (() => void)[];
  openStreams: Set<OpenStream>;
  shuttingDown: boolean;
}

export const state: TranscriptState = {
  sessions: new Map(),
  subscribers: new Set(),
  sourceWatchers: [],
  discoveryTimer: null,
  watcherState: "idle",
  shutdownHooks: [],
  openStreams: new Set(),
  shuttingDown: false,
};
