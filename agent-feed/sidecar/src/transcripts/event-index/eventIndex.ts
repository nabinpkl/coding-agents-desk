// Who is reading a transcript, for how long, and what they are told as it grows.
//
// The index itself is built in `eventIndexBuild.ts` and read in `eventIndexReads.ts`.
// This is the half that decides when either may run: the index is refcounted, so a
// reader holds it alive and the last one to leave drops it, and one chokidar watch per
// FILE fans out to every follower of that session.

import chokidar from "chokidar";
import { state, type TranscriptFollow } from "@/transcripts/transcriptState";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import type { TranscriptSourceId } from "@/transcripts/sources/transcriptTypes";
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
} from "@/transcripts/sources/transcriptTypes";

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
 * Follows a transcript for as long as anyone is reading it, and keeps its index
 * alive for the same span. Returns the release.
 *
 * One watch per file, not one per reader. Everything under this line was already
 * shared per session -- the index is refcounted, the parse is deduped through
 * `indexBuilds`, and parsed events fan out through `subscribeEvents` -- so a second
 * viewer of one thread cost nothing except the `chokidar.watch` each subscription
 * opened for itself, which is the one thing that was per-reader. Two agent windows
 * on the same session now share this.
 *
 * `onError` is per follower because a shared watcher has no single subscriber to
 * report to, and a watch that dies quietly is indistinguishable from a session that
 * stopped writing.
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
    const sync = (): void => {
      void syncIndex(source, sessionId, transcriptPath).catch(report);
    };
    // Behind any teardown for this path, so the new watch opens after the old one has closed
    // rather than racing it. What loses that race is not this follow: every watch in this
    // process shares one watcher thread, and an open contending with a close on the same path
    // is contending for the lock that thread holds against the main thread.
    const previous = state.transcriptFollowClosing.get(key);
    const watcher = (previous ?? Promise.resolve()).then(() => {
      const opened = chokidar.watch(transcriptPath, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: false,
      });
      opened.on("add", sync);
      opened.on("change", sync);
      opened.on("error", report);
      // Released while it was still opening: the release has already taken this entry out of
      // the map and has nothing to close, so the watch that just opened is nobody's.
      if (state.transcriptFollows.get(key) !== entry) void opened.close();
      return opened;
    });
    const entry: TranscriptFollow = { watcher, handlers };
    state.transcriptFollows.set(key, entry);
    follow = entry;
  }
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
      if (current.handlers.size === 0) {
        state.transcriptFollows.delete(key);
        // Recorded rather than awaited: releasing is called from a reader detaching, which
        // cannot block. `followTranscript` is what waits.
        const closed = current.watcher
          .then((watcher) => watcher.close())
          .catch((error: unknown) => {
            console.error(`transcript follow ${key} did not release its watch`, error);
          });
        state.transcriptFollowClosing.set(key, closed);
        void closed.finally(() => {
          // Only if no later teardown has replaced it, or a slow close clears a fast one's entry.
          if (state.transcriptFollowClosing.get(key) === closed) {
            state.transcriptFollowClosing.delete(key);
          }
        });
      }
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
