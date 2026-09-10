// Who is reading a transcript, for how long, and what they are told as it grows.
//
// The index itself is built in `eventIndexBuild.ts` and read in `eventIndexReads.ts`.
// This is the half that decides when either may run: the index is refcounted, so a
// reader holds it alive and the last one to leave drops it, and one chokidar watch per
// FILE fans out to every follower of that session.

import chokidar from "chokidar";
import { state, type TranscriptFollow } from "@/transcripts/transcriptState";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import type { TranscriptSourceId } from "@/transcripts/transcriptTypes";
import {
  dropIndexState,
  MAX_RAW_EVENT_BYTES,
  RawEventTooLargeError,
  niceInsertionPoint,
  type EventNotice,
  type EventSubscriber,
} from "@/transcripts/event-index/eventIndexState";
import { syncIndex } from "@/transcripts/event-index/eventIndexBuild";

export type {
  ActivityEvent,
  ActivityBlock,
  EventMode,
} from "@/transcripts/transcriptTypes";

// Re-exported because the index is one subsystem with one address: a caller must not
// reach past it to a half, since the refcounting below is what keeps the halves valid.
export {
  MAX_RAW_EVENT_BYTES,
  RawEventTooLargeError,
  niceInsertionPoint,
  type EventNotice,
  type EventSubscriber,
};
export { ensureIndexed, syncIndex } from "@/transcripts/event-index/eventIndexBuild";
export {
  getEventCount,
  getSessionUsage,
  readBlockRaw,
  readEventRaw,
  readEvents,
  translateEventIndex,
} from "@/transcripts/event-index/eventIndexReads";

export function acquireIndex(source: TranscriptSourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  state.indexReferences.set(key, (state.indexReferences.get(key) ?? 0) + 1);
}

export function releaseIndex(source: TranscriptSourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  const remaining = (state.indexReferences.get(key) ?? 1) - 1;
  if (remaining > 0) {
    state.indexReferences.set(key, remaining);
    return;
  }
  state.indexReferences.delete(key);
  dropIndexState(key);
}

/**
 * The process's one transcript watcher, and the paths on it.
 *
 * One watcher, not one per file, and a path is added once and NEVER removed. Under Bun,
 * closing a watch on a path leaves the next watch on that same path inert: measured
 * 2026-09-10, six open/close cycles on one file delivered `3, 0, 3, 0, 3, 0` events, the
 * same script on Node delivered `3, 3, 3, 3, 3, 3`, and raw `node:fs.watch` alternates the
 * same way with no chokidar in it. Chokidar's own `unwatch`/`add` alternates too, so there
 * is no escape except not to take the path off.
 *
 * What that cost, before it was understood: a thread's transcript stopped advancing on
 * every second visit. The live mirror kept streaming, so the thread looked alive while the
 * file it is a preview of sat still, and the durable rows only appeared when some unrelated
 * reader opened the same session and forced a scan. Measured on one session: 320s, 124s and
 * 33s of silence inside ten minutes, while the file grew the whole time.
 *
 * Never closing also makes the deadlock this area was ordered around unreachable rather than
 * merely avoided -- an open can no longer contend with a close on one path, because there are
 * no closes. The measured cost of 500 watched paths is no RSS change at all.
 */
function watchTranscript(key: string, transcriptPath: string): void {
  if (state.transcriptWatchedPaths.has(transcriptPath)) {
    // Already on the watcher, from this follow or from a reader who has since left. Re-point
    // it at the session that is asking now; a transcript belongs to one session, so this is
    // the same key every time except after a catalog rebuild.
    state.transcriptWatchedPaths.set(transcriptPath, key);
    return;
  }
  state.transcriptWatchedPaths.set(transcriptPath, key);
  const notify = (path: string): void => {
    const followed = state.transcriptWatchedPaths.get(path);
    if (followed === undefined) return;
    // No reader for it any more: the path stays watched, and its events cost a map lookup.
    state.transcriptFollows.get(followed)?.sync();
  };
  let watcher = state.transcriptWatcher;
  if (!watcher) {
    // Started WITH its first path. An empty `chokidar.watch([])` never reaches `ready`, so a
    // watcher created bare and filled by `add` hangs instead of watching.
    watcher = chokidar.watch(transcriptPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
    });
    watcher.on("add", notify);
    watcher.on("change", notify);
    // Not path-scoped, so it reaches every follower. A watcher-level failure is the whole
    // process's, and a watch that dies quietly is indistinguishable from a session that
    // stopped writing.
    watcher.on("error", (error) => {
      for (const follow of state.transcriptFollows.values()) {
        for (const handler of follow.handlers) handler(error);
      }
    });
    state.transcriptWatcher = watcher;
    return;
  }
  watcher.add(transcriptPath);
}

/**
 * Follows a transcript for as long as anyone is reading it, and keeps its index alive for
 * the same span. Returns the release.
 *
 * Everything under this line is shared per session -- the index is refcounted, the parse is
 * deduped through `indexBuilds`, and parsed events fan out through `subscribeEvents` -- so two
 * agent windows on one thread cost one of each. The watch is shared more widely still: see
 * `watchTranscript`, which owns the one watcher this process has.
 *
 * `onError` is per follower because a shared watcher has no single subscriber to report to.
 */
export function followTranscript(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
  onError: (error: unknown) => void,
): () => void {
  const key = sessionKey(source, sessionId);
  acquireIndex(source, sessionId);
  let follow = state.transcriptFollows.get(key);
  if (!follow) {
    const handlers = new Set<(error: unknown) => void>();
    const report = (error: unknown): void => {
      for (const handler of handlers) handler(error);
    };
    follow = {
      handlers,
      sync: () => {
        void syncIndex(source, sessionId, transcriptPath).catch(report);
      },
    };
    state.transcriptFollows.set(key, follow);
  }
  watchTranscript(key, transcriptPath);
  // A fresh closure per follower, so identical handlers never collapse into one Set
  // entry and take another follower's slot with them.
  const handler = (error: unknown): void => onError(error);
  follow.handlers.add(handler);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = state.transcriptFollows.get(key);
    if (current) {
      current.handlers.delete(handler);
      // The follow goes; the watch stays. Reading the same thread again re-registers a
      // handler against a watcher that never stopped delivering.
      if (current.handlers.size === 0) state.transcriptFollows.delete(key);
    }
    releaseIndex(source, sessionId);
  };
}

export function resetIndex(source: TranscriptSourceId, sessionId: string): void {
  dropIndexState(sessionKey(source, sessionId), { keepBuild: true });
}

export function discardIndexIfUnused(source: TranscriptSourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  if ((state.indexReferences.get(key) ?? 0) > 0) return;
  dropIndexState(key);
}

export function subscribeEvents(
  source: TranscriptSourceId,
  sessionId: string,
  subscriber: EventSubscriber,
): () => void {
  const key = sessionKey(source, sessionId);
  let subscribers = state.eventSubscribers.get(key);
  if (!subscribers) {
    subscribers = new Set();
    state.eventSubscribers.set(key, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    const current = state.eventSubscribers.get(key);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) state.eventSubscribers.delete(key);
  };
}
