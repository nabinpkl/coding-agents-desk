import { stat } from "node:fs/promises";
import { state } from "./transcriptState.ts";
import { adapterFor } from "./sources/sourceAdapters.ts";
import { sessionKey } from "./transcriptCatalog.ts";
import { mergeUsage } from "./usageState.ts";
import type {
  ActivityEvent,
  ParsedLine,
  SourceAdapter,
  SourceId,
  TokenUsage,
} from "./sources/transcriptTypes.ts";

export type { ActivityEvent, ActivityBlock } from "./sources/transcriptTypes.ts";
export type EventSubscriber = (event: ActivityEvent) => void;

export const MAX_RAW_EVENT_BYTES = 100 * 1024 * 1024;
const INDEX_READ_BYTES = 1024 * 1024;

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
function dropIndexState(key: string, options: { keepBuild?: boolean } = {}): void {
  state.eventByteOffsets.delete(key);
  state.indexedSizes.delete(key);
  state.indexed.delete(key);
  state.sessionUsage.delete(key);
  if (!options.keepBuild) state.indexBuilds.delete(key);
}

function emitParsedRaw(key: string, byteOffset: number, parsed: ParsedLine): void {
  let offsets = state.eventByteOffsets.get(key);
  if (!offsets) {
    offsets = [];
    state.eventByteOffsets.set(key, offsets);
  }
  const last = offsets.length > 0 ? offsets[offsets.length - 1]! : -1;
  if (byteOffset <= last) return;
  const event: ActivityEvent = { index: offsets.length, ...parsed };
  offsets.push(byteOffset);
  for (const subscriber of state.eventSubscribers.get(key) ?? []) {
    try {
      subscriber(event);
    } catch (error) {
      console.error("agent feed event subscriber failed", error);
    }
  }
}

async function scanFrom(
  key: string,
  adapter: SourceAdapter,
  transcriptPath: string,
  startOffset: number,
  endOffset: number,
): Promise<number> {
  let cursor = startOffset;
  let carry = new Uint8Array();
  let carryStart = startOffset;
  const decoder = new TextDecoder();
  while (cursor < endOffset) {
    const chunkEnd = Math.min(endOffset, cursor + INDEX_READ_BYTES);
    const chunk = await Bun.file(transcriptPath).slice(cursor, chunkEnd).bytes();
    const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
    combined.set(carry, 0);
    combined.set(chunk, carry.byteLength);
    let lineStart = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 0x0a) continue;
      if (index > lineStart) {
        const line = decoder.decode(combined.subarray(lineStart, index));
        const result = adapter.processLine(line);
        // Folded BEFORE the event is emitted, so a live subscriber reading the
        // session's occupancy while handling this event sees the value this very
        // line reported rather than the previous one. Replaying an already
        // indexed line is harmless: the merge overwrites `current`, it does not
        // accumulate.
        if (result?.usage) {
          state.sessionUsage.set(
            key,
            mergeUsage(state.sessionUsage.get(key), result.usage),
          );
        }
        if (result?.event) emitParsedRaw(key, carryStart + lineStart, result.event);
      }
      lineStart = index + 1;
    }
    carry = combined.slice(lineStart);
    carryStart += lineStart;
    cursor = chunkEnd;
  }
  return carryStart;
}

async function buildOrSyncIndex(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const key = sessionKey(source, sessionId);
  const inflight = state.indexBuilds.get(key);
  if (inflight) {
    await inflight;
    return;
  }
  const build = (async () => {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(transcriptPath);
    } catch {
      return;
    }
    let startOffset = state.indexedSizes.get(key) ?? 0;
    if (metadata.size < startOffset) {
      dropIndexState(key, { keepBuild: true });
      startOffset = 0;
    }
    if (metadata.size > startOffset) {
      const adapter = adapterFor(source);
      const committed = await scanFrom(
        key,
        adapter,
        transcriptPath,
        startOffset,
        metadata.size,
      );
      state.indexedSizes.set(key, committed);
    }
    state.indexed.add(key);
  })();
  state.indexBuilds.set(key, build);
  try {
    await build;
  } finally {
    state.indexBuilds.delete(key);
  }
}

export async function ensureIndexed(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}

export async function syncIndex(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}

export function acquireIndex(source: SourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  state.indexReferences.set(key, (state.indexReferences.get(key) ?? 0) + 1);
}

export function releaseIndex(source: SourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  const remaining = (state.indexReferences.get(key) ?? 1) - 1;
  if (remaining > 0) {
    state.indexReferences.set(key, remaining);
    return;
  }
  state.indexReferences.delete(key);
  dropIndexState(key);
}

export function resetIndex(source: SourceId, sessionId: string): void {
  dropIndexState(sessionKey(source, sessionId), { keepBuild: true });
}

export function discardIndexIfUnused(source: SourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  if ((state.indexReferences.get(key) ?? 0) > 0) return;
  dropIndexState(key);
}

export function getEventCount(source: SourceId, sessionId: string): number {
  return (state.eventByteOffsets.get(sessionKey(source, sessionId)) ?? []).length;
}

/**
 * Latest context-window occupancy for an indexed session, or null when the
 * transcript has published none yet.
 *
 * Read at response time rather than pushed: the indexing pass folds every line
 * it sees, so whatever this returns is as current as the index is.
 */
export function getSessionUsage(
  source: SourceId,
  sessionId: string,
): TokenUsage | null {
  return state.sessionUsage.get(sessionKey(source, sessionId)) ?? null;
}

export async function readEvents(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
  offset: number,
  limit: number,
): Promise<ActivityEvent[]> {
  await ensureIndexed(source, sessionId, transcriptPath);
  const key = sessionKey(source, sessionId);
  const offsets = state.eventByteOffsets.get(key) ?? [];
  const startIndex = Math.max(0, offset);
  if (startIndex >= offsets.length || limit <= 0) return [];
  const endIndex = Math.min(offsets.length, startIndex + limit);
  const startByte = offsets[startIndex]!;
  const metadata = await stat(transcriptPath);
  const endByte = endIndex < offsets.length ? offsets[endIndex]! : metadata.size;
  const text = await Bun.file(transcriptPath).slice(startByte, endByte).text();
  const adapter = adapterFor(source);
  const events: ActivityEvent[] = [];
  for (const line of text.split("\n")) {
    if (events.length >= limit) break;
    if (!line) continue;
    const parsed = adapter.processLine(line);
    if (parsed?.event) {
      events.push({ index: startIndex + events.length, ...parsed.event });
    }
  }
  return events;
}

export async function readEventRaw(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
  eventIndex: number,
): Promise<string | null> {
  await ensureIndexed(source, sessionId, transcriptPath);
  const offsets = state.eventByteOffsets.get(sessionKey(source, sessionId)) ?? [];
  if (eventIndex < 0 || eventIndex >= offsets.length) return null;
  const metadata = await stat(transcriptPath);
  const startByte = offsets[eventIndex]!;
  const endByte = eventIndex + 1 < offsets.length ? offsets[eventIndex + 1]! : metadata.size;
  const byteCount = endByte - startByte;
  if (byteCount > MAX_RAW_EVENT_BYTES + 1) throw new RawEventTooLargeError(byteCount);
  const bytes = await Bun.file(transcriptPath).slice(startByte, endByte).bytes();
  const newline = bytes.indexOf(0x0a);
  const lineLength = newline >= 0 ? newline : bytes.byteLength;
  if (lineLength > MAX_RAW_EVENT_BYTES) throw new RawEventTooLargeError(lineLength);
  return new TextDecoder().decode(bytes.subarray(0, lineLength));
}

export async function readBlockRaw(
  source: SourceId,
  sessionId: string,
  transcriptPath: string,
  eventIndex: number,
  blockIndex: number,
): Promise<string | null> {
  const adapter = adapterFor(source);
  if (!adapter.extractBlockRaw) return null;
  const raw = await readEventRaw(source, sessionId, transcriptPath, eventIndex);
  if (raw === null) return null;
  return adapter.extractBlockRaw(raw, blockIndex);
}

export function subscribeEvents(
  source: SourceId,
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
