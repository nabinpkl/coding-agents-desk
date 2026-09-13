import type { FSWatcher } from "chokidar";
import type { EventSubscriber } from "@/transcripts/event-index/eventIndex";
import type { DeclaredModel, Session, TokenUsage } from "@/transcripts/transcriptTypes";

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
  /** Re-reads the transcript from where the index left off. The watcher calls it; which file
   *  it reads is closed over, and `transcriptWatchedPaths` is what maps the other way. */
  sync: () => void;
  handlers: Set<(error: unknown) => void>;
}

export interface TranscriptState {
  sessions: Map<string, Session>;
  subscribers: Set<(snapshot: Session[]) => void>;
  // Whatever a source needs to stop watching. Mixed on purpose: the corpora are tree watches
  // costing a handful of descriptors each, while the Codex state database is three named files
  // and stays on chokidar, where a per-file watch is the right size.
  sourceWatchers: { close(): Promise<void> }[];
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
  // ONE watcher for every transcript this process follows, created with the first path and
  // never closed. Under Bun, closing a watch on a path leaves the NEXT watch on that same path
  // inert -- measured 2026-09-10 as a clean alternation, `3, 0, 3, 0, 3, 0` events delivered
  // over six open/close cycles, against `3, 3, 3, 3, 3, 3` on Node for the same script, and
  // reproduced on raw `node:fs.watch` with no chokidar involved. A reader leaving and another
  // arriving straight after is the ordinary case here -- a card toggled, a reader moving
  // between two cards on one session, a Vite reload -- so every second visit to a thread got a
  // dead watch and a transcript that only advanced when some other reader forced a scan.
  //
  // A path is therefore added once and never removed, which also makes the open-contending-
  // with-close deadlock unreachable rather than merely ordered around. Measured cost of 500
  // watched paths: no RSS change.
  transcriptWatcher: FSWatcher | null;
  // Which session each watched path belongs to. Outlives the follow, because the path stays on
  // the watcher after its last reader leaves.
  transcriptWatchedPaths: Map<string, string>;
  // Latest context-window occupancy per indexed session, folded line by line as
  // the index is built and extended. Lives here rather than in the catalog
  // because the indexing pass is the one place that already reads every line;
  // its lifetime is the index's, and it is dropped with it.
  sessionUsage: Map<string, TokenUsage>;
  // The model each indexed session declared, tier included, from the record that names it rather
  // than from the usage reports that do not. Beside `sessionUsage` and dropped with it, because
  // it exists to answer one question about those reports: which context window they are a
  // fraction of. Kept separately rather than folded in, because a declaration carries no tokens
  // and a session can declare its model long before it reports any.
  sessionModels: Map<string, DeclaredModel>;
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
  transcriptWatcher: null,
  transcriptWatchedPaths: new Map(),
  sessionUsage: new Map(),
  sessionModels: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
