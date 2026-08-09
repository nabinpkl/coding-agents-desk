import { stat } from "node:fs/promises";
import { state } from "./transcriptState.ts";
import { adapterFor } from "./sources/sourceAdapters.ts";
import { sessionKey } from "./transcriptCatalog.ts";
import { mergeUsage } from "./usageState.ts";
import type {
  ActivityEvent,
  EventMode,
  LineClass,
  ParsedLine,
  SourceAdapter,
  TranscriptSourceId,
  TokenUsage,
} from "./sources/transcriptTypes.ts";

export type {
  ActivityEvent,
  ActivityBlock,
  EventMode,
} from "./sources/transcriptTypes.ts";

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
  state.niceToRaw.delete(key);
  state.indexedSizes.delete(key);
  state.indexed.delete(key);
  state.sessionUsage.delete(key);
  if (!options.keepBuild) state.indexBuilds.delete(key);
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

// Re-deliver a previously emitted event to the session's subscribers without
// touching the index. Used to upsert the cache-hit badge onto a turn's last
// content event after its `token_count` line reports the prompt usage: the
// badge line is machinery, so it never has an event of its own in the nice
// view, and re-notifying with the same id lets the panel replace the row.
function renotifyEvent(
  key: string,
  notice: { event: ActivityEvent; niceIndex: number | null },
): void {
  for (const subscriber of state.eventSubscribers.get(key) ?? []) {
    try {
      subscriber(notice);
    } catch (error) {
      console.error("agent feed event subscriber failed", error);
    }
  }
}

function emitParsedRaw(
  key: string,
  byteOffset: number,
  parsed: ParsedLine,
  lineClass: LineClass | undefined,
): { event: ActivityEvent; niceIndex: number | null } | null {
  let offsets = state.eventByteOffsets.get(key);
  if (!offsets) {
    offsets = [];
    state.eventByteOffsets.set(key, offsets);
  }
  const last = offsets.length > 0 ? offsets[offsets.length - 1]! : -1;
  if (byteOffset <= last) return null;
  let niceToRaw = state.niceToRaw.get(key);
  if (!niceToRaw) {
    niceToRaw = [];
    state.niceToRaw.set(key, niceToRaw);
  }
  const rawIndex = offsets.length;
  // Absent means content: the classifier's default, and the same default the raw
  // view applies, so an adapter that has not learned about a record type yet keeps
  // it visible in both.
  const isContent = lineClass !== "machinery";
  const niceIndex = isContent ? niceToRaw.length : null;
  offsets.push(byteOffset);
  if (isContent) niceToRaw.push(rawIndex);
  const event: ActivityEvent = {
    id: `${key}:line:${rawIndex}`,
    index: rawIndex,
    revision: 0,
    phase: "complete",
    otherModeIndex: niceIndex,
    ...parsed,
  };
  renotifyEvent(key, { event, niceIndex });
  return { event, niceIndex };
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
  // The last content event emitted for this session, so a machinery line that
  // reports prompt usage (`token_count`) can hand its cache-hit badge to the
  // turn's last visible row. Replays keep this current too, which is harmless.
  //
  // Only events that carry a text block qualify. Codex emits `token_count`
  // between a response's tool calls and their results, so the immediately
  // preceding event is usually a tool row -- which the nice view folds into a
  // cluster that renders no badge. The assistant's prose row is the one a
  // viewer can actually see the badge on.
  let lastText: { event: ActivityEvent; niceIndex: number | null } | null = null;
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
        if (result?.event) {
          const isContent = result.lineClass !== "machinery";
          // A line that reports cache usage owns the badge on the event it
          // emits: content lines (Claude assistant usage) show it in both
          // views, and codex `token_count` rows show it in the raw view that
          // renders them. The nice view reads it off the re-stamped text row.
          if (result.cacheHit) result.event.cacheHit = result.cacheHit;
          const notice = emitParsedRaw(key, carryStart + lineStart, result.event, result.lineClass);
          if (notice) {
            if (isContent && result.event.blocks.some((block) => block.kind === "text")) {
              lastText = notice;
            } else if (result.cacheHit && lastText) {
              // Codex `token_count`: the badge also belongs on the turn's last
              // prose row, which was already emitted. Re-notify with the same
              // id so the panel upserts the badge onto it. The revision bumps
              // so the panel's upsert filter (newer revision wins) accepts the
              // badge exactly like the live mirror's cache re-stamp does.
              lastText.event.revision += 1;
              lastText.event.cacheHit = result.cacheHit;
              renotifyEvent(key, lastText);
            }
          }
        }
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
  source: TranscriptSourceId,
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
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}

export async function syncIndex(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  await buildOrSyncIndex(source, sessionId, transcriptPath);
}

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

export function resetIndex(source: TranscriptSourceId, sessionId: string): void {
  dropIndexState(sessionKey(source, sessionId), { keepBuild: true });
}

export function discardIndexIfUnused(source: TranscriptSourceId, sessionId: string): void {
  const key = sessionKey(source, sessionId);
  if ((state.indexReferences.get(key) ?? 0) > 0) return;
  dropIndexState(key);
}

export function getEventCount(
  source: TranscriptSourceId,
  sessionId: string,
  mode: EventMode = "raw",
): number {
  const key = sessionKey(source, sessionId);
  const table = mode === "nice" ? state.niceToRaw : state.eventByteOffsets;
  return (table.get(key) ?? []).length;
}

/**
 * Translate an event index from one mode to the other.
 *
 * Returns null when there is no counterpart, which happens in exactly one
 * direction: a machinery line addressed in raw mode is absent from the nice view.
 * Used to keep the viewer's place across a mode switch.
 */
export function translateEventIndex(
  source: TranscriptSourceId,
  sessionId: string,
  eventIndex: number,
  from: EventMode,
): number | null {
  const niceToRaw = state.niceToRaw.get(sessionKey(source, sessionId)) ?? [];
  if (eventIndex < 0) return null;
  if (from === "nice") return niceToRaw[eventIndex] ?? null;
  const point = niceInsertionPoint(niceToRaw, eventIndex);
  return niceToRaw[point] === eventIndex ? point : null;
}

/**
 * Latest context-window occupancy for an indexed session, or null when the
 * transcript has published none yet.
 *
 * Read at response time rather than pushed: the indexing pass folds every line
 * it sees, so whatever this returns is as current as the index is.
 */
export function getSessionUsage(
  source: TranscriptSourceId,
  sessionId: string,
): TokenUsage | null {
  return state.sessionUsage.get(sessionKey(source, sessionId)) ?? null;
}

/**
 * Read one page of events in the requested mode.
 *
 * The mode changes what an index MEANS, and this is the function where getting
 * that wrong is invisible. It reads the byte span between two indexed lines and
 * re-parses everything inside it, and in nice mode the omitted lines are still
 * physically interleaved in that span -- so the same classification the index
 * applied has to be applied again here. Skip that and row N stops being event N,
 * which does not fail anywhere: it surfaces as a Raw drawer showing a different
 * line, a paging anchor landing in the wrong place, and a sticky jump to the wrong
 * row.
 */
export async function readEvents(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
  offset: number,
  limit: number,
  mode: EventMode = "raw",
): Promise<ActivityEvent[]> {
  await ensureIndexed(source, sessionId, transcriptPath);
  const key = sessionKey(source, sessionId);
  const offsets = state.eventByteOffsets.get(key) ?? [];
  const niceToRaw = state.niceToRaw.get(key) ?? [];
  const nice = mode === "nice";
  const total = nice ? niceToRaw.length : offsets.length;
  const startIndex = Math.max(0, offset);
  if (startIndex >= total || limit <= 0) return [];
  const endIndex = Math.min(total, startIndex + limit);

  // Both bounds resolve through the raw index, because byte offsets are only
  // stored per raw line: nice event N lives at `offsets[niceToRaw[N]]`.
  const startRaw = nice ? niceToRaw[startIndex]! : startIndex;
  const endRaw = nice
    ? (endIndex < total ? niceToRaw[endIndex]! : offsets.length)
    : endIndex;
  const startByte = offsets[startRaw]!;
  const metadata = await stat(transcriptPath);
  const endByte = endRaw < offsets.length ? offsets[endRaw]! : metadata.size;
  const text = await Bun.file(transcriptPath).slice(startByte, endByte).text();
  const adapter = adapterFor(source);
  const events: ActivityEvent[] = [];
  // Counters for the two views, advanced independently: raw counts every line with
  // an event, nice counts only the content ones. Seeded from the index so both stay
  // absolute rather than window-relative.
  let rawCursor = startRaw;
  let niceCursor = nice ? startIndex : niceInsertionPoint(niceToRaw, startRaw);
  // Last content event that carries a text block, so a machinery `token_count`
  // line can hand its cache-hit badge to the turn's prose row instead of the
  // tool row that precedes it (Codex emits `token_count` between a response's
  // tool calls and their results, and tool rows fold into clusters that render
  // no badge). A badge whose `token_count` opens the window is dropped: its
  // turn's last row lives in the previous window and was already delivered (the
  // live tail re-stamps those, since it processes lines in order).
  let lastTextEvent: ActivityEvent | null = null;
  for (const line of text.split("\n")) {
    if (events.length >= limit) break;
    if (!line) continue;
    const parsed = adapter.processLine(line);
    if (!parsed?.event) continue;
    const isContent = parsed.lineClass !== "machinery";
    const rawIndex = rawCursor++;
    const niceIndex = isContent ? niceCursor++ : null;
    if (!isContent) {
      if (parsed.cacheHit) {
        if (lastTextEvent) lastTextEvent.cacheHit = parsed.cacheHit;
        // The raw view renders the machinery row itself (the "Token Usage"
        // row), so it carries the badge there; the nice view hides it and
        // reads the badge off the text row instead.
        parsed.event.cacheHit = parsed.cacheHit;
      }
      if (nice) continue;
      events.push({
        id: `${key}:line:${rawIndex}`,
        index: rawIndex,
        revision: 0,
        phase: "complete",
        otherModeIndex: null,
        ...parsed.event,
      });
      continue;
    }
    const event: ActivityEvent = {
      id: `${key}:line:${rawIndex}`,
      index: nice ? niceIndex! : rawIndex,
      revision: 0,
      phase: "complete",
      otherModeIndex: nice ? rawIndex : niceIndex,
      ...parsed.event,
    };
    if (parsed.cacheHit) event.cacheHit = parsed.cacheHit;
    events.push(event);
    if (event.blocks.some((block) => block.kind === "text")) lastTextEvent = event;
  }
  return events;
}

export async function readEventRaw(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
  eventIndex: number,
  mode: EventMode = "raw",
): Promise<string | null> {
  await ensureIndexed(source, sessionId, transcriptPath);
  const key = sessionKey(source, sessionId);
  const offsets = state.eventByteOffsets.get(key) ?? [];
  const rawIndex = mode === "nice"
    ? translateEventIndex(source, sessionId, eventIndex, "nice")
    : eventIndex;
  if (rawIndex === null || rawIndex < 0 || rawIndex >= offsets.length) return null;
  const metadata = await stat(transcriptPath);
  const startByte = offsets[rawIndex]!;
  const endByte = rawIndex + 1 < offsets.length ? offsets[rawIndex + 1]! : metadata.size;
  const byteCount = endByte - startByte;
  if (byteCount > MAX_RAW_EVENT_BYTES + 1) throw new RawEventTooLargeError(byteCount);
  const bytes = await Bun.file(transcriptPath).slice(startByte, endByte).bytes();
  const newline = bytes.indexOf(0x0a);
  const lineLength = newline >= 0 ? newline : bytes.byteLength;
  if (lineLength > MAX_RAW_EVENT_BYTES) throw new RawEventTooLargeError(lineLength);
  return new TextDecoder().decode(bytes.subarray(0, lineLength));
}

export async function readBlockRaw(
  source: TranscriptSourceId,
  sessionId: string,
  transcriptPath: string,
  eventIndex: number,
  blockIndex: number,
  mode: EventMode = "raw",
): Promise<string | null> {
  const adapter = adapterFor(source);
  if (!adapter.extractBlockRaw) return null;
  const raw = await readEventRaw(source, sessionId, transcriptPath, eventIndex, mode);
  if (raw === null) return null;
  return adapter.extractBlockRaw(raw, blockIndex);
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
