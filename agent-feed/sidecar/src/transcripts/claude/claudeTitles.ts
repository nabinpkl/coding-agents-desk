// The title a Claude transcript wears NOW: its last `custom-title` record anywhere in the file.
//
// The catalog reads a transcript's two 32 KB edges and nothing else, and for most fields that is
// the right trade. For the title it gave a confidently stale answer. Claude re-emits the session's
// title as it goes, but not on every write: measured on one long session here, 1.3 MB of tool
// output once passed between two title records. While that is in the tail window, the tail holds
// no title, the head holds the FIRST one, and the catalog reported the session's oldest name as
// its current one -- on a row, and to the Bot title queue, which then renamed a session back to a
// task it had already left.
//
// So the answer is remembered per file with how far it was read, and every later read covers only
// what was appended since. A transcript is append-only, which is what makes that exact. The first
// read of a file whose tail holds no title reads backwards for the latest one, which stops at the
// first it meets. A file with no title in either edge is left as the edges say: finding one in the
// middle would mean reading the whole file on every refresh of every untitled session.

import type { open } from "node:fs/promises";

type FileHandle = Awaited<ReturnType<typeof open>>;

export interface Titles {
  customTitle?: string;
  aiTitle?: string;
}

/** What `readHeader` saw in its two windows, in byte offsets. */
export interface EdgeTitles {
  /** One window covered the whole file, so `tail` already is the answer. */
  whole: boolean;
  head: Titles;
  tail: Titles;
  /** Where the tail window's first complete line starts. Everything before it is outside the tail. */
  tailFrom: number;
  /** Where the last complete line in the file ends: a later read resumes here. */
  through: number;
}

/** The answer as of `through`, so the next read only covers what came after. */
interface TitleMemo extends Titles {
  through: number;
}

const memos = new Map<string, TitleMemo>();

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/** Reads one title field off a JSON line, or nothing. */
export function titlesOf(line: string | Buffer, into: Titles): void {
  const text = typeof line === "string" ? line : line.toString("utf-8");
  if (!text.includes('"customTitle"') && !text.includes('"aiTitle"')) return;
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    record = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof record.aiTitle === "string" && record.aiTitle.trim()) into.aiTitle = record.aiTitle.trim();
  if (typeof record.customTitle === "string" && record.customTitle.trim()) {
    into.customTitle = record.customTitle.trim();
  }
}

export async function currentTitles(fh: FileHandle, path: string, edges: EdgeTitles): Promise<Titles> {
  let titles: Titles;
  const memo = memos.get(path);
  if (edges.whole) {
    titles = { ...edges.tail };
  } else if (memo && memo.through <= edges.through) {
    // Appended since the last read: the tail window covers the end of it, and anything between
    // where that read stopped and where the tail starts is read once, here.
    const gap: Titles = memo.through < edges.tailFrom ? await forwardTitles(fh, memo.through, edges.tailFrom) : {};
    titles = {
      customTitle: edges.tail.customTitle ?? gap.customTitle ?? memo.customTitle,
      aiTitle: edges.tail.aiTitle ?? gap.aiTitle ?? memo.aiTitle,
    };
  } else {
    // First read, or a file that shrank and so is not the one remembered.
    const customTitle =
      edges.tail.customTitle ?? (edges.head.customTitle ? await lastCustomTitleBefore(fh, edges.tailFrom) : undefined);
    titles = { customTitle, aiTitle: edges.tail.aiTitle ?? edges.head.aiTitle };
  }
  memos.set(path, { ...titles, through: edges.through });
  return titles;
}

/** The last titles on the complete lines in [from, to), both of which are line starts. */
async function forwardTitles(fh: FileHandle, from: number, to: number): Promise<Titles> {
  const titles: Titles = {};
  let position = from;
  let pending = Buffer.alloc(0);
  while (position < to) {
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, to - position));
    const { bytesRead } = await fh.read(buf, 0, buf.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    const window = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
    let start = 0;
    for (let br = window.indexOf(NEWLINE); br !== -1; br = window.indexOf(NEWLINE, start)) {
      titlesOf(window.subarray(start, br), titles);
      start = br + 1;
    }
    pending = window.subarray(start);
  }
  return titles;
}

/** The last `customTitle` on a complete line ending at or before `end`, read backwards. */
async function lastCustomTitleBefore(fh: FileHandle, end: number): Promise<string | undefined> {
  let position = end;
  // The front of a line whose start is in an earlier chunk than the one that read it.
  let carry = Buffer.alloc(0);
  while (position > 0) {
    const start = Math.max(0, position - CHUNK_BYTES);
    const buf = Buffer.alloc(position - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    if (bytesRead !== buf.length) return undefined;
    position = start;
    const window = Buffer.concat([buf, carry]);
    // Unless this chunk starts the file, its first line began in the chunk before it.
    const first = start === 0 ? -1 : window.indexOf(NEWLINE);
    if (start > 0 && first === -1) {
      carry = window;
      continue;
    }
    const body = window.subarray(first + 1);
    for (let at = body.lastIndexOf('"customTitle"'); at !== -1;) {
      const lineStart = body.lastIndexOf(NEWLINE, at) + 1;
      const lineEnd = body.indexOf(NEWLINE, at);
      const found: Titles = {};
      titlesOf(body.subarray(lineStart, lineEnd === -1 ? body.length : lineEnd), found);
      if (found.customTitle) return found.customTitle;
      at = lineStart > 0 ? body.lastIndexOf('"customTitle"', lineStart - 1) : -1;
    }
    carry = window.subarray(0, first + 1);
  }
  return undefined;
}
