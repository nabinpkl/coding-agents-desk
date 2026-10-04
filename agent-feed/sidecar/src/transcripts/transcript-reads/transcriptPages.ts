// Turning transcript lines into the rows a reader is shown, a page at a time from wherever the
// reader is.
//
// A row is named by the byte its line starts at (`transcriptLines.ts` carries why), and that one
// number is its index in BOTH views: a machinery line is simply absent from the nice one rather
// than shifting every number after it. What the numbers no longer say is which rows are
// neighbours, so every row carries `previous`, the row before it in the same view, read off the
// file while it is being read anyway.

import { adapterFor } from "@/transcripts/sourceAdapters";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { mergeDeclaredModel, mergeUsage, withDeclaredModel } from "@/transcripts/usageState";
import type {
  ActivityEvent,
  DeclaredModel,
  EventMode,
  LineResult,
  TokenUsage,
  TranscriptSourceId,
} from "@/transcripts/transcriptTypes";
import {
  completeEnd,
  isLineStart,
  lineAt,
  linesBefore,
  linesFrom,
  NotALineStartError,
} from "@/transcripts/transcript-reads/transcriptLines";

/** One page, read backwards from a position. */
export interface TranscriptPage {
  events: ActivityEvent[];
  /**
   * Where the page starts: the oldest row's index when there are older rows to page to, and 0
   * when the page reaches the first row of the file. A reader asks for the next older page
   * BEFORE this, and stops when it is 0.
   */
  windowStart: number;
  /** The end of the last complete line the page was read against, where a follow resumes. */
  end: number;
}

/** A line that parsed into an event, with where it starts. */
export interface ParsedTranscriptLine {
  position: number;
  result: LineResult & { event: NonNullable<LineResult["event"]> };
}

function visibleIn(result: LineResult, mode: EventMode): boolean {
  return mode === "raw" || result.lineClass !== "machinery";
}

/**
 * The events a run of consecutive parsed lines produces in one mode, oldest first.
 *
 * `previous` is the row before the first of them in this mode, which the caller knows and this
 * does not. Also re-stamps a machinery line's cache badge onto the turn's last prose row, the way
 * the index's read did: Codex writes `token_count` between a response's tool calls and their
 * results, and the badge belongs on the row a reader can see it on. A badge whose `token_count`
 * opens the run is dropped, since its turn's prose row is in the page before.
 */
export function eventsOf(
  source: TranscriptSourceId,
  sessionId: string,
  lines: readonly ParsedTranscriptLine[],
  mode: EventMode,
  previous: number | null,
): ActivityEvent[] {
  const key = sessionKey(source, sessionId);
  const events: ActivityEvent[] = [];
  let last = previous;
  let lastText: ActivityEvent | null = null;
  for (const { position, result } of lines) {
    const content = result.lineClass !== "machinery";
    if (!content && result.cacheHit) {
      if (lastText) lastText.cacheHit = result.cacheHit;
    }
    if (!visibleIn(result, mode)) continue;
    const event: ActivityEvent = {
      id: `${key}:at:${position}`,
      index: position,
      previous: last,
      revision: 0,
      phase: "complete",
      otherModeIndex: content ? position : null,
      ...result.event,
    };
    // The raw view renders a machinery row itself ("Token Usage"), so it carries the badge there
    // too; a content line owns the badge its own usage reported.
    if (result.cacheHit) event.cacheHit = result.cacheHit;
    events.push(event);
    last = position;
    if (content && event.blocks.some((block) => block.kind === "text")) lastText = event;
  }
  return events;
}

/**
 * The newest `limit` rows ending before `before`, or before the end of the file when it is null.
 *
 * Reads backwards until it has one row MORE than it returns, because that extra row is what the
 * oldest returned row's `previous` is, and whether it exists is what `windowStart` says. Cost is
 * the size of the page, never the size of the file.
 */
export async function readPageBefore(
  source: TranscriptSourceId,
  sessionId: string,
  path: string,
  before: number | null,
  limit: number,
  mode: EventMode,
): Promise<TranscriptPage> {
  if (before !== null && !(await isLineStart(path, before))) {
    throw new NotALineStartError(`${before} is not where a line starts`);
  }
  const end = before ?? await completeEnd(path);
  const adapter = adapterFor(source);
  const collected: ParsedTranscriptLine[] = [];
  let visible = 0;
  await linesBefore(path, end, (line) => {
    const result = adapter.processLine(line.text);
    if (!result?.event) return true;
    collected.push({ position: line.position, result: result as ParsedTranscriptLine["result"] });
    if (visibleIn(result, mode)) visible += 1;
    return visible <= limit;
  });
  collected.reverse();
  let extra: number | null = null;
  let from = 0;
  if (visible > limit) {
    from = collected.findIndex(({ result }) => visibleIn(result, mode));
    extra = collected[from]!.position;
    from += 1;
  }
  const events = eventsOf(source, sessionId, collected.slice(from), mode, extra);
  return { events, windowStart: extra === null ? 0 : (events[0]?.index ?? 0), end };
}

/**
 * Every line from `from` up to `end` that parses into an event, oldest first.
 *
 * For the readers that genuinely want a span rather than a page: a follow catching up, a handover
 * that renders a whole conversation, a fork anchor counting what comes after a message.
 */
export async function parsedLinesBetween(
  source: TranscriptSourceId,
  path: string,
  from: number,
  end: number,
): Promise<ParsedTranscriptLine[]> {
  const adapter = adapterFor(source);
  const lines: ParsedTranscriptLine[] = [];
  await linesFrom(path, from, end, (line) => {
    const result = adapter.processLine(line.text);
    if (result?.event) lines.push({ position: line.position, result: result as ParsedTranscriptLine["result"] });
    return true;
  });
  return lines;
}

/** The rows from `from` up to `end` in one mode, oldest first; `previous` as for `eventsOf`. */
export async function readEventsBetween(
  source: TranscriptSourceId,
  sessionId: string,
  path: string,
  from: number,
  end: number,
  mode: EventMode,
  previous: number | null,
): Promise<ActivityEvent[]> {
  return eventsOf(source, sessionId, await parsedLinesBetween(source, path, from, end), mode, previous);
}

/** The exact line a row was read from, or null when no line starts there. */
export async function readEventRaw(path: string, position: number): Promise<string | null> {
  try {
    return await lineAt(path, position);
  } catch (error) {
    if (error instanceof NotALineStartError) return null;
    throw error;
  }
}

/** One block of a row, resolved the way its adapter stores it. */
export async function readBlockRaw(
  source: TranscriptSourceId,
  path: string,
  position: number,
  blockIndex: number,
): Promise<string | null> {
  const adapter = adapterFor(source);
  if (!adapter.extractBlockRaw) return null;
  const raw = await readEventRaw(path, position);
  if (raw === null) return null;
  return adapter.extractBlockRaw(raw, blockIndex);
}

/** What a session's occupancy meter starts from: its newest reading and its declared model. */
export interface SessionMeter {
  usage: TokenUsage | null;
  model: DeclaredModel | undefined;
}

/**
 * How far back from the end the meter is looked for. Every assistant line reports usage, so this
 * is reached only by a session whose recent end is one enormous tool result.
 */
const METER_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * How far back a declaration is waited for once a report naming a model has been found. A session
 * written by a CLI older than 2.1.265 declares nothing, and must not pay the whole scan for a
 * record it will never have; one that does declares within 16 lines of every compaction.
 */
const DECLARATION_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * How much of the top of the file is read for the model declaration. Claude declares its model
 * near the top (line 11 to 29, measured) and again after every compaction; the top is where a
 * session that has not compacted for a long time keeps its tier.
 */
const HEAD_SCAN_BYTES = 256 * 1024;

/**
 * The meter as of `end`, from the newest lines that say anything about it plus the top of the
 * file, rather than from a fold over every line.
 *
 * The fold this replaces kept the newest usage report, restated in the declared model's terms,
 * and inherited the model and limit from the last report that named one. Reading back until a
 * report naming a model has been found, with a declaration before it, recovers the same answer
 * for any session whose last such pair is within the scan; the top of the file covers the
 * declaration of one that has not compacted since it started.
 */
export async function readSessionMeter(
  source: TranscriptSourceId,
  path: string,
  end: number,
): Promise<SessionMeter> {
  const adapter = adapterFor(source);
  const tail: LineResult[] = [];
  let scanned = 0;
  let namedUsage = false;
  let declaredBeforeIt = false;
  await linesBefore(path, end, (line) => {
    scanned += line.text.length + 1;
    const result = adapter.processLine(line.text);
    if (result?.usage || result?.declaredModel) {
      tail.push(result);
      if (namedUsage && result.declaredModel) declaredBeforeIt = true;
      if (result.usage?.model !== undefined) namedUsage = true;
    }
    return scanned < METER_SCAN_BYTES
      && !(namedUsage && (declaredBeforeIt || scanned >= DECLARATION_SCAN_BYTES));
  });
  tail.reverse();
  const tailStart = tail.length > 0 ? end - scanned : end;
  const head: DeclaredModel[] = [];
  const headEnd = Math.min(tailStart, HEAD_SCAN_BYTES);
  if (headEnd > 0) {
    await linesFrom(path, 0, await lineBoundaryAtOrBefore(path, headEnd), (line) => {
      const declared = adapter.processLine(line.text)?.declaredModel;
      if (declared) head.push(declared);
      return true;
    });
  }
  let model: DeclaredModel | undefined;
  for (const declared of head) model = mergeDeclaredModel(model, declared);
  let usage: TokenUsage | undefined;
  for (const result of tail) {
    if (result.declaredModel) model = mergeDeclaredModel(model, result.declaredModel);
    if (result.usage) usage = mergeUsage(usage, withDeclaredModel(result.usage, model));
  }
  return { usage: usage ?? null, model };
}

/**
 * A line start at or before `position`, so a bounded forward read ends on a boundary. Handed a
 * position inside a line, the first line `linesBefore` cuts is that one, truncated; only its start
 * is used, and that start is real.
 */
async function lineBoundaryAtOrBefore(path: string, position: number): Promise<number> {
  let boundary = 0;
  await linesBefore(path, position, (line) => {
    boundary = line.position;
    return false;
  });
  return boundary;
}

export { completeEnd, isLineStart, NotALineStartError };
