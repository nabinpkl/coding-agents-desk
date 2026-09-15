// Who is reading a transcript, for how long, and what they are told as it grows.
//
// The index itself is built in `eventIndexBuild.ts` and read in `eventIndexReads.ts`.
// This is the half that decides when either may run: the index is refcounted, so a
// reader holds it alive and the last one to leave drops it, and a write published by
// the catalog's corpus watch fans out to every follower of that session.

import { state, type TranscriptFollow } from "@/transcripts/transcriptState";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { onTranscriptWrite } from "@/transcripts/catalog/transcriptWrites";
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
 * The process's one listener for transcript writes, registered with the first follow.
 *
 * This index does NOT watch files. It reads the signal the catalog's corpus watches already
 * produce: one recursive `fs.watch` per corpus, published through `publishTranscriptWrite`.
 * `transcriptWrites.ts` carries the measurement that made that the right way round, and the
 * short version is that hundreds of per-file watches in a long-lived process went 30 to 200
 * seconds late while the one recursive watch beside them stayed current to the second.
 *
 * Never unregistered, because it is one closure for the process and it costs a map lookup for
 * a path nobody follows. A follow that has gone is simply not found.
 *
 * What a follower is no longer told: that the WATCH failed. A corpus watch that dies is the
 * catalog's to report and it says so in the log, where the old per-file watcher raised to every
 * follower instead. `onError` below still carries what this half can see, which is a read that
 * failed. A watch that dies quietly leaves a followed transcript sitting still with nothing
 * saying why, and the thing that would close that hole is a stat of each followed file on a
 * timer rather than a second watcher.
 */
let writesRouted = false;

function routeWritesToFollows(): void {
  if (writesRouted) return;
  writesRouted = true;
  onTranscriptWrite((path) => {
    const followed = state.transcriptFollowsByPath.get(path);
    if (followed === undefined) return;
    state.transcriptFollows.get(followed)?.sync();
  });
}

/**
 * Follows a transcript for as long as anyone is reading it, and keeps its index alive for
 * the same span. Returns the release.
 *
 * Everything under this line is shared per session -- the index is refcounted, the parse is
 * deduped through `indexBuilds`, and parsed events fan out through `subscribeEvents` -- so two
 * agent windows on one thread cost one of each. What tells the follow its file grew is shared
 * across the whole process: see `routeWritesToFollows`.
 *
 * `onError` is per follower because a shared follow has no single subscriber to report to.
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
  routeWritesToFollows();
  // Re-pointed rather than added once: a transcript belongs to one session, so this is the same
  // key every time except after a catalog rebuild, and then the newer one is the one to wake.
  state.transcriptFollowsByPath.set(transcriptPath, key);
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
        // And its route with it, so the map is bounded by who is reading rather than by every
        // session this process has ever shown. Guarded on the key, because a rebuild can have
        // re-pointed this path at a different session that is still being read.
        if (state.transcriptFollowsByPath.get(transcriptPath) === key) {
          state.transcriptFollowsByPath.delete(transcriptPath);
        }
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
