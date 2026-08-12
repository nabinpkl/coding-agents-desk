import type { FSWatcher } from "chokidar";
import type { EventSubscriber } from "./eventIndex.ts";
import type { Session, TokenUsage } from "./sources/transcriptTypes.ts";

export type WatcherState = "idle" | "reconciling" | "live";

export interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  teardown: () => void;
}

/**
 * The one watch on a transcript file, and everyone reading through it.
 *
 * Refcounted by `handlers.size` rather than a separate counter: every follower
 * registers exactly one error handler, so the two cannot come apart. The handlers
 * exist because a shared watcher has no single subscriber to fail to, and a watch
 * that dies silently looks exactly like a session that stopped writing.
 */
export interface TranscriptFollow {
  watcher: FSWatcher;
  handlers: Set<(error: unknown) => void>;
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
  // Sessions whose file grew while their index build was already running. That
  // build started from the size it saw when it began, so those bytes are outside
  // it; the flag makes it look again before it settles rather than leaving them
  // for the next filesystem event, which -- now that there is one watcher per
  // file instead of one per reader -- may not come.
  indexResyncs: Set<string>;
  indexReferences: Map<string, number>;
  // One watch per followed transcript, shared by every reader of it.
  transcriptFollows: Map<string, TranscriptFollow>;
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
  indexResyncs: new Set(),
  indexReferences: new Map(),
  transcriptFollows: new Map(),
  sessionUsage: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
