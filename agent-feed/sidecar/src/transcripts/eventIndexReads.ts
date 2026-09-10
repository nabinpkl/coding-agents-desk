// Answering a reader out of a built index: how many events there are, what one mode's
// index is in the other, the session's running usage, and the events and raw lines
// themselves.

import { stat } from "node:fs/promises";
import { state } from "@/transcripts/transcriptState";
import { adapterFor } from "@/transcripts/sources/sourceAdapters";
import { sessionKey } from "@/transcripts/transcriptCatalog";
import type {
  ActivityEvent,
  EventMode,
  TranscriptSourceId,
  TokenUsage,
} from "@/transcripts/sources/transcriptTypes";
import { MAX_RAW_EVENT_BYTES, niceInsertionPoint, RawEventTooLargeError } from "@/transcripts/eventIndexState";
import { ensureIndexed } from "@/transcripts/eventIndexBuild";

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
