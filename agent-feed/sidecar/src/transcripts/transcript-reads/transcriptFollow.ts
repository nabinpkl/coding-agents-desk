// Who is reading a transcript as it grows, and what they are told.
//
// One follow per followed transcript, shared by every reader of it: it remembers how far it has
// read and nothing else about the file, and hands each new line to whoever is listening. It holds
// no index, so there is nothing to build when the first reader arrives and nothing to drop when
// the last one leaves -- a reader starts from the position its own opening page ended at.
//
// What tells a follow its file grew is shared across the whole process: the catalog's corpus
// watches publish every write through `transcriptWrites.ts`. That file carries the measurement
// that made one recursive watch the right way round, against hundreds of per-file watches that
// went 30 to 200 seconds late in a long-lived process.

import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { onTranscriptWrite } from "@/transcripts/catalog/transcriptWrites";
import { mergeDeclaredModel, mergeUsage, withDeclaredModel } from "@/transcripts/usageState";
import type { TokenUsage, TranscriptSourceId } from "@/transcripts/transcriptTypes";
import { adapterFor } from "@/transcripts/sourceAdapters";
import { completeEnd, linesFrom } from "@/transcripts/transcript-reads/transcriptLines";
import type { ParsedTranscriptLine, SessionMeter } from "@/transcripts/transcript-reads/transcriptPages";

export type FollowListener = (line: ParsedTranscriptLine) => void;

interface TranscriptFollow {
  path: string;
  source: TranscriptSourceId;
  /** Where the next unread line starts, or null until the first reader says where it began. */
  cursor: number | null;
  /** The occupancy meter as of `cursor`, folded forward line by line. */
  meter: SessionMeter;
  syncing: Promise<void> | null;
  /** A write landed during a sync, which measured the file before it; look again before settling. */
  resync: boolean;
  listeners: Set<FollowListener>;
  handlers: Set<(error: unknown) => void>;
}

const follows = new Map<string, TranscriptFollow>();
const followsByPath = new Map<string, string>();
let writesRouted = false;

function routeWritesToFollows(): void {
  if (writesRouted) return;
  writesRouted = true;
  onTranscriptWrite((path) => {
    const key = followsByPath.get(path);
    if (key === undefined) return;
    const follow = follows.get(key);
    if (follow) requestSync(follow);
  });
}

function report(follow: TranscriptFollow, error: unknown): void {
  for (const handler of follow.handlers) handler(error);
}

function requestSync(follow: TranscriptFollow): void {
  if (follow.cursor === null) return;
  if (follow.syncing) {
    follow.resync = true;
    return;
  }
  follow.syncing = (async () => {
    try {
      do {
        follow.resync = false;
        await syncOnce(follow);
      } while (follow.resync);
    } catch (error) {
      report(follow, error);
    } finally {
      follow.syncing = null;
    }
  })();
}

async function syncOnce(follow: TranscriptFollow): Promise<void> {
  const from = follow.cursor;
  if (from === null) return;
  const end = await completeEnd(follow.path);
  if (end < from) {
    // A transcript is only appended to, so a shorter one was rewritten under us and every position
    // a reader holds may now name the middle of a line. Said rather than papered over: the reader
    // reopens and is handed a fresh page against the new file.
    follow.cursor = end;
    throw new Error(`transcript ${follow.path} shrank from ${from} to ${end} bytes; reopen to read it again`);
  }
  if (end === from) return;
  const adapter = adapterFor(follow.source);
  await linesFrom(follow.path, from, end, (line) => {
    const result = adapter.processLine(line.text);
    if (result?.declaredModel) follow.meter.model = mergeDeclaredModel(follow.meter.model, result.declaredModel);
    if (result?.usage) {
      follow.meter.usage = mergeUsage(
        follow.meter.usage ?? undefined,
        withDeclaredModel(result.usage, follow.meter.model),
      );
    }
    if (result?.event) {
      const parsed = { position: line.position, result: result as ParsedTranscriptLine["result"] };
      for (const listener of follow.listeners) {
        try {
          listener(parsed);
        } catch (error) {
          console.error("transcript follow listener failed", error);
        }
      }
    }
    // Advanced line by line rather than once at the end, so a reader joining mid-sync is told
    // exactly where the lines it has not heard begin.
    follow.cursor = line.end;
    return true;
  });
  follow.cursor = end;
}

/** A reader's hold on a followed transcript. */
export interface FollowHandle {
  /**
   * Starts the follow from `end` with the meter as of there, unless it is already running; either
   * way returns where it is reading from now, which may be ahead of `end` if another reader
   * started it later. Lines from that position on reach the listener; anything between `end` and
   * it is the caller's to read.
   */
  start(end: number, meter: SessionMeter): number;
  /** The session's occupancy as of the newest line read. */
  usage(): TokenUsage | null;
  release(): void;
}

/**
 * Follows a transcript for as long as anyone is reading it. `listener` hears every line that
 * parses into an event, in file order, from the moment this is called.
 *
 * `onError` is per reader because a shared follow has no single subscriber to report to, and a
 * read that fails silently looks exactly like a session that stopped writing.
 */
export function followTranscript(
  source: TranscriptSourceId,
  sessionId: string,
  path: string,
  listener: FollowListener,
  onError: (error: unknown) => void,
): FollowHandle {
  const key = sessionKey(source, sessionId);
  let follow = follows.get(key);
  if (!follow) {
    follow = {
      path,
      source,
      cursor: null,
      meter: { usage: null, model: undefined },
      syncing: null,
      resync: false,
      listeners: new Set(),
      handlers: new Set(),
    };
    follows.set(key, follow);
  }
  routeWritesToFollows();
  // Re-pointed rather than added once: a transcript belongs to one session, so this is the same
  // key every time except after a catalog rebuild, and then the newer one is the one to wake.
  followsByPath.set(path, key);
  const current = follow;
  // Fresh closures per reader, so identical functions never collapse into one Set entry and take
  // another reader's slot with them.
  const heard: FollowListener = (line) => listener(line);
  const handler = (error: unknown): void => onError(error);
  current.listeners.add(heard);
  current.handlers.add(handler);
  let released = false;
  return {
    start(end, meter) {
      if (current.cursor === null) {
        current.cursor = end;
        current.meter = { ...meter };
      }
      const from = current.cursor;
      requestSync(current);
      return from;
    },
    usage: () => current.meter.usage,
    release() {
      if (released) return;
      released = true;
      current.listeners.delete(heard);
      current.handlers.delete(handler);
      if (current.handlers.size > 0) return;
      if (follows.get(key) === current) follows.delete(key);
      // Guarded on the key, because a rebuild can have re-pointed this path at a different
      // session that is still being read.
      if (followsByPath.get(path) === key) followsByPath.delete(path);
    },
  };
}

/** Asks the follow on `path` to look at its file again, for a caller that knows it just grew. */
export function syncFollowedTranscript(source: TranscriptSourceId, sessionId: string): void {
  const follow = follows.get(sessionKey(source, sessionId));
  if (follow) requestSync(follow);
}

/** Forgets every follow; for tests, which share this process. */
export function clearFollowsForTest(): void {
  follows.clear();
  followsByPath.clear();
}
