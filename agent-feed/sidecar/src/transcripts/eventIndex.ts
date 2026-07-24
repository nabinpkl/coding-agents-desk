// Activity event index per session. Source of truth for the Agent Panel's
// virtualized activity feed (paginated reads + SSE tail).
//
// Index is a `byteOffsets[i] = byte position where parsed event i starts`
// array, populated incrementally by the watcher's per-file drain. Pagination
// reads (`readEvents`) lazy-build the index from disk if the watcher hasn't
// reached the file yet.
//
// `state.indexed` gates whether the in-memory offsets array for a session is
// trustworthy as a complete picture from byte 0. Until that gate flips,
// `emitParsed` from the watcher's drain is a no-op so the Agent Panel cannot
// observe a partial index. The gate flips inside `buildIndexFromDisk`.
//
// Parsing is delegated to the session's source adapter. This file knows about
// byte offsets and subscriber fan-out; it does not know the JSONL shape.

import { stat } from 'node:fs/promises';
import { state } from './transcriptState.ts';
import { adapterFor } from './sources/sourceAdapters.ts';
import type { ActivityEvent, ParsedLine, SourceAdapter } from './sources/transcriptTypes.ts';

export type { ActivityEvent, ActivityBlock } from './sources/transcriptTypes.ts';
export type EventSubscriber = (event: ActivityEvent) => void;

export const MAX_RAW_EVENT_BYTES = 100 * 1024 * 1024;

export class RawEventTooLargeError extends Error {
  readonly byteCount: number;

  constructor(byteCount: number) {
    super(`raw event is ${byteCount} bytes; maximum is ${MAX_RAW_EVENT_BYTES}`);
    this.name = 'RawEventTooLargeError';
    this.byteCount = byteCount;
  }
}

// Internal push, used inside `buildIndexFromDisk`. Monotonic-forward dedupe:
// since the only callers scan forward from a known position, a repeat at or
// before the last known offset is a no-op. Cheap, no extra memory.
function emitParsedRaw(sessionId: string, byteOffset: number, parsed: ParsedLine): void {
  let offsets = state.eventByteOffsets.get(sessionId);
  if (!offsets) {
    offsets = [];
    state.eventByteOffsets.set(sessionId, offsets);
  }
  const last = offsets.length > 0 ? offsets[offsets.length - 1]! : -1;
  if (byteOffset <= last) return;
  const event: ActivityEvent = { index: offsets.length, ...parsed };
  offsets.push(byteOffset);
  const subs = state.eventSubscribers.get(sessionId);
  if (subs && subs.size > 0) {
    for (const fn of subs) {
      try { fn(event); } catch { /* subscriber threw; isolate */ }
    }
  }
}

// Called by the watcher's drain for every parsed line that produces an event.
// Gated: until `buildIndexFromDisk` has populated the offsets for this
// session, drain emits are no-ops so the index never appears partial.
export function emitParsed(sessionId: string, byteOffset: number, parsed: ParsedLine): void {
  if (!state.indexed.has(sessionId)) return;
  emitParsedRaw(sessionId, byteOffset, parsed);
}

// Reset the index for a session (used when a file is truncated/rotated or
// the session has been pruned from disk).
export function resetIndex(sessionId: string): void {
  state.eventByteOffsets.delete(sessionId);
  state.indexed.delete(sessionId);
}

export function getEventCount(sessionId: string): number {
  return (state.eventByteOffsets.get(sessionId) ?? []).length;
}

// One-shot full scan from byte 0. Used when readEvents is called for a
// session the watcher's drain has been gated for. Side-effect: populates the
// index, marks the session indexed, fans out to any current subscribers.
// Concurrent callers coalesce on a per-session inflight promise so the scan
// runs at most once.
async function buildIndexFromDisk(
  sessionId: string,
  adapter: SourceAdapter,
  transcriptPath: string,
): Promise<void> {
  if (state.indexed.has(sessionId)) return;
  const inflight = state.indexBuilds.get(sessionId);
  if (inflight) {
    await inflight;
    return;
  }
  const p = (async () => {
    try {
      let st: Awaited<ReturnType<typeof stat>>;
      try { st = await stat(transcriptPath); } catch { return; }
      if (st.size === 0) {
        state.indexed.add(sessionId);
        return;
      }

      const file = Bun.file(transcriptPath);
      const buf = await file.slice(0, st.size).bytes();
      const decoder = new TextDecoder();

      let pos = 0;
      while (pos < buf.length) {
        let nl = pos;
        while (nl < buf.length && buf[nl] !== 0x0a) nl++;
        const lineStart = pos;
        if (nl > pos) {
          const line = decoder.decode(buf.slice(pos, nl));
          const r = adapter.processLine(line);
          if (r?.event) emitParsedRaw(sessionId, lineStart, r.event);
        }
        if (nl >= buf.length) break;
        pos = nl + 1;
      }
      state.indexed.add(sessionId);
    } catch {
      // Build failed mid-scan; leave the session un-indexed so a future
      // readEvents retries cleanly. Coalesced waiters see a resolved promise.
    }
  })();
  state.indexBuilds.set(sessionId, p);
  try {
    await p;
  } finally {
    state.indexBuilds.delete(sessionId);
  }
}

// Read [offset, offset+limit) by seeking to byteOffsets[offset] and parsing
// just that slice. Builds the index lazily on first call.
export async function readEvents(
  sessionId: string,
  transcriptPath: string,
  offset: number,
  limit: number,
): Promise<ActivityEvent[]> {
  const session = state.sessions.get(sessionId);
  if (!session) return [];
  const adapter = adapterFor(session.source);

  if (!state.indexed.has(sessionId)) {
    await buildIndexFromDisk(sessionId, adapter, transcriptPath);
  }
  const offsets = state.eventByteOffsets.get(sessionId) ?? [];
  if (offset < 0) offset = 0;
  if (offset >= offsets.length || limit <= 0) return [];

  const startByte = offsets[offset]!;
  const endIdx = offset + limit;
  let endByte: number;
  if (endIdx < offsets.length) {
    endByte = offsets[endIdx]!;
  } else {
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(transcriptPath); } catch { return []; }
    endByte = st.size;
  }

  const file = Bun.file(transcriptPath);
  const text = await file.slice(startByte, endByte).text();
  const out: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    if (out.length >= limit) break;
    if (!line) continue;
    const r = adapter.processLine(line);
    if (r?.event) out.push({ index: offset + out.length, ...r.event });
  }
  return out;
}

// Read the raw, uncapped content of one block of one event. Seeks to the
// byte offset already in the index, slurps just that line, and delegates
// schema knowledge to the adapter's extractBlockRaw. Returns null when the
// session, index, or block is unknown.
export async function readBlockRaw(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
): Promise<string | null> {
  const session = state.sessions.get(sessionId);
  if (!session) return null;
  const adapter = adapterFor(session.source);
  if (!adapter.extractBlockRaw) return null;
  if (!state.indexed.has(sessionId)) {
    await buildIndexFromDisk(sessionId, adapter, session.transcriptPath);
  }
  const offsets = state.eventByteOffsets.get(sessionId) ?? [];
  if (eventIndex < 0 || eventIndex >= offsets.length) return null;
  const startByte = offsets[eventIndex]!;
  let endByte: number;
  if (eventIndex + 1 < offsets.length) {
    endByte = offsets[eventIndex + 1]!;
  } else {
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(session.transcriptPath); } catch { return null; }
    endByte = st.size;
  }
  const file = Bun.file(session.transcriptPath);
  const text = await file.slice(startByte, endByte).text();
  const nl = text.indexOf('\n');
  const line = nl >= 0 ? text.slice(0, nl) : text;
  if (!line) return null;
  try {
    return adapter.extractBlockRaw(line, blockIndex);
  } catch {
    return null;
  }
}

// Read the exact source text for one indexed JSONL event. The terminating LF
// belongs to the physical record separator and is not returned. Unlike block
// expansion this never parses or reserializes the record.
export async function readEventRaw(
  sessionId: string,
  eventIndex: number,
): Promise<string | null> {
  const session = state.sessions.get(sessionId);
  if (!session) return null;
  const adapter = adapterFor(session.source);
  if (!state.indexed.has(sessionId)) {
    await buildIndexFromDisk(sessionId, adapter, session.transcriptPath);
  }
  const offsets = state.eventByteOffsets.get(sessionId) ?? [];
  if (eventIndex < 0 || eventIndex >= offsets.length) return null;

  let st: Awaited<ReturnType<typeof stat>>;
  try { st = await stat(session.transcriptPath); } catch { return null; }
  const startByte = offsets[eventIndex]!;
  const available = Math.max(0, st.size - startByte);
  const probeLength = Math.min(available, MAX_RAW_EVENT_BYTES + 1);
  const bytes = await Bun.file(session.transcriptPath)
    .slice(startByte, startByte + probeLength)
    .bytes();
  const newline = bytes.indexOf(0x0a);
  const lineLength = newline >= 0 ? newline : bytes.length;
  if (lineLength > MAX_RAW_EVENT_BYTES || (newline < 0 && available > MAX_RAW_EVENT_BYTES)) {
    let exactLength = lineLength;
    if (newline < 0 && available > MAX_RAW_EVENT_BYTES) {
      const nextOffset = eventIndex + 1 < offsets.length ? offsets[eventIndex + 1]! : st.size;
      exactLength = Math.max(MAX_RAW_EVENT_BYTES + 1, nextOffset - startByte);
    }
    throw new RawEventTooLargeError(exactLength);
  }
  return new TextDecoder().decode(bytes.subarray(0, lineLength));
}

// Ensure the in-memory index is at least as far along as disk. Cheap when
// the session is already indexed. Used by the SSE stream handler before
// backfilling so subscribers do not miss events written between the
// page-read and the subscribe.
export async function ensureIndexed(sessionId: string, transcriptPath: string): Promise<void> {
  if (state.indexed.has(sessionId)) return;
  const session = state.sessions.get(sessionId);
  if (!session) return;
  const adapter = adapterFor(session.source);
  await buildIndexFromDisk(sessionId, adapter, transcriptPath);
}

export function subscribeEvents(sessionId: string, fn: EventSubscriber): () => void {
  let set = state.eventSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    state.eventSubscribers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = state.eventSubscribers.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) state.eventSubscribers.delete(sessionId);
  };
}
