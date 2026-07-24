import type { FSWatcher } from "chokidar";
import type { EventSubscriber } from "./eventIndex.ts";
import type { Session } from "./sources/transcriptTypes.ts";

export type WatcherState = "idle" | "reconciling" | "live";

export interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  teardown: () => void;
}

export interface TailWatcherEntry {
  watcher: FSWatcher;
  lastFireAt: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  draining: boolean;
  pending: boolean;
}

export interface TranscriptState {
  sessions: Map<string, Session>;
  subscribers: Set<(snapshot: Session[]) => void>;
  tailWatchers: Map<string, TailWatcherEntry>;
  discoveryTeardowns: Array<() => void>;
  discoveryRescans: Array<() => Promise<void>>;
  cacheSaveTimer: ReturnType<typeof setTimeout> | null;
  pruneTimer: ReturnType<typeof setInterval> | null;
  safetyTimer: ReturnType<typeof setInterval> | null;
  watcherState: WatcherState;
  eventByteOffsets: Map<string, number[]>;
  indexed: Set<string>;
  indexBuilds: Map<string, Promise<void>>;
  eventSubscribers: Map<string, Set<EventSubscriber>>;
  openStreams: Set<OpenStream>;
  shuttingDown: boolean;
}

export const state: TranscriptState = {
  sessions: new Map(),
  subscribers: new Set(),
  tailWatchers: new Map(),
  discoveryTeardowns: [],
  discoveryRescans: [],
  cacheSaveTimer: null,
  pruneTimer: null,
  safetyTimer: null,
  watcherState: "idle",
  eventByteOffsets: new Map(),
  indexed: new Set(),
  indexBuilds: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
