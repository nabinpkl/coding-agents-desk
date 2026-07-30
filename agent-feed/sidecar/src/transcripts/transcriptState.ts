import type { FSWatcher } from "chokidar";
import type { EventSubscriber } from "./eventIndex.ts";
import type { Session, TokenUsage } from "./sources/transcriptTypes.ts";

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
  // Raw event index -> byte offset of its line.
  eventByteOffsets: Map<string, number[]>;
  // Nice event index -> RAW event index, not a byte offset. Nice event N's byte
  // offset is therefore `eventByteOffsets[niceToRaw[N]]`, which makes switching
  // modes an array read instead of a search. Built in the same pass as
  // eventByteOffsets so the two cannot come apart.
  //
  // There is deliberately no reverse map: raw -> nice is a binary search in this
  // array plus a local counter over the window being read, which costs nothing at
  // read time and removes a second copy that could drift from this one.
  niceToRaw: Map<string, number[]>;
  indexedSizes: Map<string, number>;
  indexed: Set<string>;
  indexBuilds: Map<string, Promise<void>>;
  indexReferences: Map<string, number>;
  // Latest context-window occupancy per indexed session, folded line by line as
  // the index is built and extended. Lives here rather than in the catalog
  // because the indexing pass is the one place that already reads every line;
  // its lifetime is the index's, and it is dropped with it.
  sessionUsage: Map<string, TokenUsage>;
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
  niceToRaw: new Map(),
  indexedSizes: new Map(),
  indexed: new Set(),
  indexBuilds: new Map(),
  indexReferences: new Map(),
  sessionUsage: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
