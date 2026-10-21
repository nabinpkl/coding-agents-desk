// The newest `<task-state>` block a Claude transcript holds, kept current the way its title is.
//
// The catalog reads a transcript's two 32 KB edges, and a block written before a long tool result
// falls between them. So, like `claudeTitles.ts`, the answer is remembered per file with how far it
// was read, and every later read covers only what was appended since: a transcript is append-only,
// which is what makes that exact.
//
// The first read of a file looks back a bounded distance rather than through the whole file. The
// block is new to the posture, so a long transcript written before it holds none, and reading every
// one of them end to end the first time the catalog sees it would be the cost of finding nothing.
//
// Only the session's own words count: an `assistant` record from the main thread, never a person's
// message, a tool result, or a subagent's turn. A fork's transcript starts with its parent's
// records, so a fork shows its parent's block until its first response writes its own.
//
// The same pass follows the session's spoken status (`claudeSpokenStatus.ts`), so the two blocks a
// session reports itself with cost one read of each new byte between them.

import type { open } from "node:fs/promises";
import {
  emptySpokenStatusTrack,
  followSpokenStatus,
  type SpokenStatusTrack,
} from "@/transcripts/claude/claudeSpokenStatus";
import type { SessionSpokenStatus } from "@/transcripts/spokenStatus";
import { mayHoldTaskState, parseTaskState, type SessionTaskState } from "@/transcripts/taskState";

type FileHandle = Awaited<ReturnType<typeof open>>;

interface TaskStateMemo {
  state: SessionTaskState | null;
  spoken: SpokenStatusTrack;
  /** Where the last read stopped, at a line start: the next read resumes here. */
  through: number;
}

const memos = new Map<string, TaskStateMemo>();

/** How far back a file's first read looks for a block. */
const FIRST_READ_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/** What a session reports about itself: its newest task block, and how its latest turn stands. */
export interface SessionReports {
  taskState?: SessionTaskState;
  spokenStatus?: SessionSpokenStatus;
}

/**
 * The newest task block in the file at `path`, and its spoken status, read up to `through`, where
 * the last complete line ends.
 */
export async function currentReports(fh: FileHandle, path: string, through: number): Promise<SessionReports> {
  const memo = memos.get(path);
  // A file shorter than what was read of it is not the file that was remembered.
  const resumes = memo !== undefined && memo.through <= through;
  const from = resumes ? memo.through : Math.max(0, through - FIRST_READ_BYTES);
  let state = resumes ? memo.state : null;
  // Copied rather than moved in place, so a read that fails part way leaves the memo as it was.
  const spoken: SpokenStatusTrack = resumes ? { ...memo.spoken } : emptySpokenStatusTrack();
  if (from < through) {
    // A first read that starts mid-file starts mid-line; a resumed one starts where a line did.
    const newer = await newestBetween(fh, from, through, !resumes && from > 0, spoken);
    if (newer) state = newer;
  }
  memos.set(path, { state, spoken, through });
  return {
    ...(state ? { taskState: state } : {}),
    ...(spoken.status ? { spokenStatus: spoken.status } : {}),
  };
}

/** The newest task block on the complete lines in [from, to), moving `spoken` past each line. */
async function newestBetween(
  fh: FileHandle,
  from: number,
  to: number,
  skipFirstLine: boolean,
  spoken: SpokenStatusTrack,
): Promise<SessionTaskState | null> {
  let newest: SessionTaskState | null = null;
  let position = from;
  let pending = Buffer.alloc(0);
  let skipping = skipFirstLine;
  while (position < to) {
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, to - position));
    const { bytesRead } = await fh.read(buf, 0, buf.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    const window = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
    let start = 0;
    for (let br = window.indexOf(NEWLINE); br !== -1; br = window.indexOf(NEWLINE, start)) {
      if (skipping) {
        skipping = false;
      } else {
        const line = window.toString("utf-8", start, br);
        newest = taskStateOfLine(line) ?? newest;
        followSpokenStatus(line, spoken);
      }
      start = br + 1;
    }
    pending = window.subarray(start);
  }
  return newest;
}

/** The block one transcript line carries, when it is the session's own text and opens with one. */
export function taskStateOfLine(line: string): SessionTaskState | null {
  if (!mayHoldTaskState(line)) return null;
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.type !== "assistant" || record.isSidechain === true) return null;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const state = parseTaskState(text, Number.isFinite(at) ? at : 0);
    if (state) return state;
  }
  return null;
}
