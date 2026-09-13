// The bookkeeping every other half of the event index shares: what a subscriber is
// told, how big a raw event may be, where a nice index lands a raw line, and the one
// place a session's index is dropped from.

import { state } from "@/transcripts/transcriptState";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

/**
 * One newly indexed line, addressed in both views.
 *
 * A subscriber is opened for a particular mode, so it needs both numbers: the raw
 * event carries its raw index, and `niceIndex` is null for a machinery line, which
 * a nice-mode subscriber then skips entirely.
 */
export interface EventNotice {
  event: ActivityEvent;
  niceIndex: number | null;
}

export type EventSubscriber = (notice: EventNotice) => void;

export const MAX_RAW_EVENT_BYTES = 100 * 1024 * 1024;
export const INDEX_READ_BYTES = 1024 * 1024;

export class RawEventTooLargeError extends Error {
  readonly byteCount: number;

  constructor(byteCount: number) {
    super(`raw event is ${byteCount} bytes; maximum is ${MAX_RAW_EVENT_BYTES}`);
    this.name = "RawEventTooLargeError";
    this.byteCount = byteCount;
  }
}

// One home for dropping a session's index. Every entry keyed by `key` in
// transcriptState belongs here, so a new per-index map gains its teardown once
// instead of in each of the four callers that used to repeat this block.
//
// `keepBuild` is for the one caller that runs INSIDE the build promise (the
// truncation reset): forgetting the in-flight entry there would let a concurrent
// request start a second build over the same file.
export function dropIndexState(key: string, options: { keepBuild?: boolean } = {}): void {
  state.eventByteOffsets.delete(key);
  state.niceToRaw.delete(key);
  state.indexedSizes.delete(key);
  state.indexed.delete(key);
  state.sessionUsage.delete(key);
  if (!options.keepBuild) {
    state.indexBuilds.delete(key);
    // Paired with the build entry, not with the index data: it is a request made OF
    // an in-flight build, so it is meaningless once that build is forgotten.
    state.indexResyncs.delete(key);
  }
}

/**
 * Index of the first nice event whose raw index is >= `rawIndex`.
 *
 * Doubles as the raw -> nice translation: when `niceToRaw[result] === rawIndex` the
 * line IS nice event `result`, and otherwise it is machinery and `result` names the
 * nearest content event after it. Binary search over the ascending array, so no
 * reverse map has to be stored and kept in step.
 */
export function niceInsertionPoint(niceToRaw: number[], rawIndex: number): number {
  let low = 0;
  let high = niceToRaw.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (niceToRaw[middle]! < rawIndex) low = middle + 1;
    else high = middle;
  }
  return low;
}
