import type { FSWatcher } from "chokidar";
import type { EventSubscriber } from "./eventIndex.ts";
import type { Session } from "./sources/transcriptTypes.ts";

export type WatcherState = "idle" | "reconciling" | "live";

export interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  teardown: () => void;
}

export interface TranscriptState {
  sessions: Map<string, Session>;
  subscribers: Set<(snapshot: Session[]) => void>;
  sourceWatchers: FSWatcher[];
  discoveryTimer: ReturnType<typeof setInterval> | null;
  watcherState: WatcherState;
  eventByteOffsets: Map<string, number[]>;
  indexedSizes: Map<string, number>;
  indexed: Set<string>;
  indexBuilds: Map<string, Promise<void>>;
  indexReferences: Map<string, number>;
  eventSubscribers: Map<string, Set<EventSubscriber>>;
  openStreams: Set<OpenStream>;
  shuttingDown: boolean;
}

export const state: TranscriptState = {
  sessions: new Map(),
  subscribers: new Set(),
  sourceWatchers: [],
  discoveryTimer: null,
  watcherState: "idle",
  eventByteOffsets: new Map(),
  indexedSizes: new Map(),
  indexed: new Set(),
  indexBuilds: new Map(),
  indexReferences: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
