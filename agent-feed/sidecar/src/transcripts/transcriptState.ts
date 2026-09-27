import type { EventSubscriber } from "@/transcripts/event-index/eventIndex";
import type { DeclaredModel, Session, TokenUsage } from "@/transcripts/transcriptTypes";

export type WatcherState = "idle" | "reconciling" | "live";

export interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  teardown: () => void;
}

/**
 * One followed transcript, and everyone reading through it.
 *
 * Refcounted by `handlers.size` rather than a separate counter: every follower
 * registers exactly one error handler, so the two cannot come apart. The handlers
 * exist because a follow is shared and has no single subscriber to fail to, and a
 * read that fails silently looks exactly like a session that stopped writing.
 */
export interface TranscriptFollow {
  /** Re-reads the transcript from where the index left off. A published write calls it; which
   *  file it reads is closed over, and `transcriptFollowsByPath` is what maps the other way. */
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
  /**
   * What shutdown has to stop beyond the transcript sources: long-lived loops the process started
   * itself, such as the opencode hub adapter's streams. Each is a synchronous stop; the shutdown
   * path runs them in order and reports one that throws rather than swallowing it.
   */
  shutdownHooks: (() => void)[];
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
  // for the next filesystem event, which may never come: a file that has stopped
  // growing produces nothing more to be told about.
  indexResyncs: Set<string>;
  indexReferences: Map<string, number>;
  // One follow per followed transcript, shared by every reader of it.
  transcriptFollows: Map<string, TranscriptFollow>;
  // Which session a written transcript path belongs to, so a write published by the catalog's
  // corpus watch reaches the follow that wants it. Dropped with the follow: this process no
  // longer holds a watch per path, so there is nothing left that has to outlive its readers.
  transcriptFollowsByPath: Map<string, string>;
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
  shutdownHooks: [],
  eventByteOffsets: new Map(),
  niceToRaw: new Map(),
  indexedSizes: new Map(),
  indexed: new Set(),
  indexBuilds: new Map(),
  indexResyncs: new Set(),
  indexReferences: new Map(),
  transcriptFollows: new Map(),
  transcriptFollowsByPath: new Map(),
  sessionUsage: new Map(),
  sessionModels: new Map(),
  eventSubscribers: new Map(),
  openStreams: new Set(),
  shuttingDown: false,
};
