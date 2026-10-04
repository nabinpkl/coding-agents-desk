// A transcript as lines at byte positions, read from wherever the reader is rather than from the
// top.
//
// This is what replaced the event index. The index numbered every line from the start of the file,
// so a row could only be named after the whole file had been parsed: 464ms on a 136MB transcript,
// on the sidecar's one thread, paid again on every page load because the index was dropped with
// its last reader (measured 2026-10-04, ten open cards costing 1.1s of parsing per load while every
// other route queued behind it). A transcript is only ever appended to, so the byte a line starts
// at is already a name that never changes and needs nothing above it to be known. Every read here
// starts at a position and walks as far as its caller asks, in either direction.

import { stat } from "node:fs/promises";

/** How much of the file one read takes, in either direction. */
export const LINE_READ_BYTES = 1024 * 1024;

/** The largest single line a reader is handed. A line past it is refused rather than buffered. */
export const MAX_LINE_BYTES = 100 * 1024 * 1024;

export class LineTooLargeError extends Error {
  readonly byteCount: number;

  constructor(byteCount: number) {
    super(`transcript line is ${byteCount} bytes; maximum is ${MAX_LINE_BYTES}`);
    this.name = "LineTooLargeError";
    this.byteCount = byteCount;
  }
}

/** A position that is not where a line begins: the caller named a byte inside a line. */
export class NotALineStartError extends Error {}

export interface TranscriptLine {
  /** The byte the line starts at, which is the line's name. */
  position: number;
  /** One past the line's newline: where the next line starts. */
  end: number;
  /** The line's text, without its newline. */
  text: string;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.byteLength === 0) return tail;
  if (tail.byteLength === 0) return head;
  const both = new Uint8Array(head.byteLength + tail.byteLength);
  both.set(head, 0);
  both.set(tail, head.byteLength);
  return both;
}

/**
 * The end of the last COMPLETE line: the file's size when it ends in a newline, and otherwise the
 * start of the line still being written. A line without its newline is a write in progress, and a
 * reader handed half of one would parse nothing and then never be told about the rest.
 */
export async function completeEnd(path: string): Promise<number> {
  const size = (await stat(path)).size;
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - LINE_READ_BYTES);
    const chunk = await Bun.file(path).slice(start, cursor).bytes();
    const newline = chunk.lastIndexOf(NEWLINE);
    if (newline !== -1) return start + newline + 1;
    cursor = start;
  }
  return 0;
}

/** Whether `position` is where a line begins: the start of the file, or just after a newline. */
export async function isLineStart(path: string, position: number): Promise<boolean> {
  if (position === 0) return true;
  if (position < 0) return false;
  const before = await Bun.file(path).slice(position - 1, position).bytes();
  return before.byteLength === 1 && before[0] === NEWLINE;
}

/**
 * Every complete line ending at or before `end`, newest first, until `visit` returns false.
 *
 * `end` must be a line boundary; the reads that hand one in got it from `completeEnd` or from a
 * line's own position. Blank lines are skipped, as every reader of these files always has.
 */
export async function linesBefore(
  path: string,
  end: number,
  visit: (line: TranscriptLine) => boolean,
): Promise<void> {
  let cursor = end;
  // Bytes already read that belong to a line whose start is further back than the last chunk.
  let tail: Uint8Array = new Uint8Array();
  while (cursor > 0) {
    const start = Math.max(0, cursor - LINE_READ_BYTES);
    const buffer = joined(await Bun.file(path).slice(start, cursor).bytes(), tail);
    // `lineEnd` is one past the newline that ends the line being cut out; the line's own newline
    // is the byte before it, so the search for the line BEFORE it starts two bytes back.
    let lineEnd = buffer.byteLength;
    while (lineEnd >= 2) {
      const newline = buffer.lastIndexOf(NEWLINE, lineEnd - 2);
      if (newline === -1) break;
      const text = decoder.decode(buffer.subarray(newline + 1, lineEnd - 1));
      if (text && !visit({ position: start + newline + 1, end: start + lineEnd, text })) return;
      lineEnd = newline + 1;
    }
    tail = buffer.slice(0, lineEnd);
    if (tail.byteLength > MAX_LINE_BYTES) throw new LineTooLargeError(tail.byteLength);
    cursor = start;
  }
  // What is left is the file's first line, which has no newline in front of it to be found by.
  if (tail.byteLength > 1) {
    const text = decoder.decode(tail.subarray(0, tail.byteLength - 1));
    if (text) visit({ position: 0, end: tail.byteLength, text });
  }
}

/**
 * Every complete line from `from` up to `end`, oldest first, until `visit` returns false.
 *
 * `from` must be a line start and `end` a line boundary. Returns where reading stopped, which is
 * `end` when every line was visited.
 */
export async function linesFrom(
  path: string,
  from: number,
  end: number,
  visit: (line: TranscriptLine) => boolean,
): Promise<number> {
  let cursor = from;
  let carry: Uint8Array = new Uint8Array();
  let carryStart = from;
  while (cursor < end) {
    const chunkEnd = Math.min(end, cursor + LINE_READ_BYTES);
    const buffer = joined(carry, await Bun.file(path).slice(cursor, chunkEnd).bytes());
    let lineStart = 0;
    for (let newline = buffer.indexOf(NEWLINE); newline !== -1; newline = buffer.indexOf(NEWLINE, lineStart)) {
      if (newline > lineStart) {
        const text = decoder.decode(buffer.subarray(lineStart, newline));
        if (!visit({ position: carryStart + lineStart, end: carryStart + newline + 1, text })) return carryStart + lineStart;
      }
      lineStart = newline + 1;
    }
    carry = buffer.slice(lineStart);
    if (carry.byteLength > MAX_LINE_BYTES) throw new LineTooLargeError(carry.byteLength);
    carryStart += lineStart;
    cursor = chunkEnd;
  }
  return carryStart;
}

/** The one line starting at `position`, or null past the last complete line. */
export async function lineAt(path: string, position: number): Promise<string | null> {
  if (!(await isLineStart(path, position))) throw new NotALineStartError(`${position} is not where a line starts`);
  let found: string | null = null;
  const end = await completeEnd(path);
  if (position >= end) return null;
  // Bounded by the line cap rather than by the file: one line is all this ever wants.
  const limit = Math.min(end, position + MAX_LINE_BYTES + 1);
  let cursor = position;
  let carry: Uint8Array = new Uint8Array();
  while (cursor < limit && found === null) {
    const chunkEnd = Math.min(limit, cursor + LINE_READ_BYTES);
    carry = joined(carry, await Bun.file(path).slice(cursor, chunkEnd).bytes());
    const newline = carry.indexOf(NEWLINE);
    if (newline !== -1) found = decoder.decode(carry.subarray(0, newline));
    cursor = chunkEnd;
  }
  if (found === null) throw new LineTooLargeError(carry.byteLength);
  return found;
}
