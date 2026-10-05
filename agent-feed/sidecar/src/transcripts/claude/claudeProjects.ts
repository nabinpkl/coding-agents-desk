// Claude's files on disk: where a session's transcript lives, what the catalog can
// learn from its edges without reading it whole, and the sidecar file a large tool
// result was persisted to.

import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config } from "@/config/config";
import { isHarnessUserText } from "@/transcripts/humanTurns";
import type { Header } from "@/transcripts/transcriptTypes";
import { turnClosedFor } from "@/transcripts/claude/claudePayloads";
import { currentTitles, titlesOf, type Titles } from "@/transcripts/claude/claudeTitles";

const HEADER_EDGE_BYTES = 32 * 1024;
/**
 * How far past the head window the OPENING `cwd` is looked for, when the window has none.
 *
 * Measured across this machine's 1218 Claude transcripts: 280 are larger than the two edge
 * windows and carry no `cwd` inside the head one, because a resumed session opens with
 * `file-history-snapshot` records around 15 KB each and four of them outrun 32 KB. Every one of
 * those 280 answers within 852 KB, median 96 KB, so a megabyte covers them with headroom -- and
 * only a file that needs the scan pays for it, since it stops at the first `cwd` it sees.
 */
const OPENING_CWD_SCAN_BYTES = 1024 * 1024;

export async function readSidecar(sidecarPath: string): Promise<string | null> {
  const abs = resolve(sidecarPath);
  if (!abs.startsWith(config.claudeProjectsDirectory + '/')) return null;
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
}

/** The prose of a user message, whose content is either a string or a block list. */
export function userText(message: unknown): string | undefined {
  if (typeof message === 'string') return message.trim() || undefined;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'text') continue;
    if (typeof record.text === 'string' && record.text.trim()) return record.text.trim();
  }
  return undefined;
}

/**
 * The opening prompt a line carries, from the two records that can hold one.
 *
 * `user` is the ordinary case. `queue-operation`/`enqueue` is how a command that
 * was queued rather than typed arrives, and for some sessions it is the ONLY
 * record of the prompt: a `/security-review` run has no `user` line near its head
 * at all, so without this branch those sessions render as their own UUID.
 *
 * A compaction summary is skipped. It is a resumed context rather than something
 * a person asked for, and it is long, so it makes a uniquely bad title.
 */
export function promptText(ev: Record<string, unknown>): string | undefined {
  if (ev.type === 'user') {
    if (ev.isCompactSummary === true) return undefined;
    // A line Claude marks `isMeta` it wrote itself, whatever the text: an image's size note, a Stop
    // hook's feedback, a skill's preamble.
    if (ev.isMeta === true) return undefined;
    const text = userText(ev.message);
    // The harness writes interrupts, caveats, slash-command echoes and task notifications as
    // user messages. None is prose a person chose, so none is more useful as a title than the id.
    if (text && isHarnessUserText(text)) return undefined;
    return text;
  }
  if (ev.type === 'queue-operation' && ev.operation === 'enqueue') {
    return typeof ev.content === 'string' ? ev.content.trim() || undefined : undefined;
  }
  return undefined;
}

/**
 * The opening prompt of a session whose first record does not fit the head window.
 *
 * A queued command carries its whole payload on one line, and `/security-review`
 * enqueues a file list, so that single record can be larger than the whole 32 KB
 * edge. The window then holds one truncated line, `JSON.parse` refuses it, and the
 * session has no title and no prompt left to fall back to -- it renders as its own
 * UUID. Three sessions in this repo land there.
 *
 * The prompt is at the FRONT of that record though, so it is inside the window; only
 * the closing brace is missing. So the string value is read directly rather than the
 * object being repaired, because a truncated object cannot be repaired without
 * guessing what was cut.
 */
export function promptFromOversizedRecord(text: string): string | undefined {
  const match = /"content":"((?:[^"\\]|\\.){0,400})/.exec(text);
  if (!match?.[1]) return undefined;
  // The capture can end mid-escape, which is not a valid string body. Drop the stub.
  const body = match[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '');
  try {
    return (JSON.parse(`"${body}"`) as string).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first `cwd` after `from`, for a transcript whose opening records outrun the head window.
 *
 * Reads forward in the same 32 KB steps and stops at the first record that answers, so a file
 * that opens with four oversized snapshots costs one extra read and a file that does not costs
 * nothing. Lines are cut on the byte rather than on the decoded string: a chunk boundary can
 * fall inside a multi-byte character, and decoding each half alone would lose the record it
 * split.
 */
async function scanForOpeningCwd(
  fh: Awaited<ReturnType<typeof open>>,
  from: number,
  size: number,
): Promise<string | undefined> {
  const stop = Math.min(size, from + OPENING_CWD_SCAN_BYTES);
  let position = from;
  let pending = Buffer.alloc(0);
  while (position < stop) {
    const buf = Buffer.alloc(Math.min(HEADER_EDGE_BYTES, stop - position));
    const { bytesRead } = await fh.read(buf, 0, buf.length, position);
    if (!bytesRead) return undefined;
    position += bytesRead;
    const window = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
    let start = 0;
    for (let br = window.indexOf(0x0a); br !== -1; br = window.indexOf(0x0a, start)) {
      const line = window.toString('utf-8', start, br);
      start = br + 1;
      if (line) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev && typeof ev === 'object' && typeof ev.cwd === 'string') return ev.cwd;
        } catch { /* a line this scan cannot read is one it does not need */ }
      }
    }
    pending = window.subarray(start);
  }
  return undefined;
}

/**
 * What the catalog knows about a session without reading its body: the two 32 KB
 * edges, and everything the session list needs pulled out of them.
 *
 * The edge size is measured, not guessed. Across this repo's 119 Claude
 * transcripts, 113 carry their title inside these two windows; of the six that do
 * not, five have no title anywhere in the file, so a full scan finds nothing more.
 * Widening to 64 KB recovers one session and 128 KB recovers none, which is why
 * the answer to a missing title is `promptText` above rather than a bigger read.
 */
export async function readHeader(filePath: string): Promise<Header | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(filePath, 'r'); } catch { return null; }
  try {
    const metadata = await fh.stat();
    const ranges = metadata.size <= HEADER_EDGE_BYTES * 2
      ? [{ start: 0, length: metadata.size }]
      : [
        { start: 0, length: HEADER_EDGE_BYTES },
        { start: metadata.size - HEADER_EDGE_BYTES, length: HEADER_EDGE_BYTES },
      ];
    const out: Header = {};
    // Kept apart and ranked at the end rather than overwriting each other in file
    // order, because file order gives the wrong answer: the harness re-emits its
    // generated title as a session goes on, so a name the USER chose is routinely
    // followed by a generated one, and last-write-wins would rename their session
    // back for them. Per window, because which window said it decides whether it is
    // current: `claudeTitles.ts` has why.
    const head: Titles = {};
    const tail: Titles = {};
    let tailFrom = 0;
    let through = 0;
    for (const [index, range] of ranges.entries()) {
      // A small file is one range that is both edges, so it answers both
      // questions. A large one splits them, and each question has exactly one
      // range that can answer it: the head knows how the session opened, the tail
      // knows whether its turn is still open. Reading either from the wrong end
      // gives a confident wrong answer.
      const isHead = index === 0;
      const isTail = index === ranges.length - 1;
      const buf = Buffer.alloc(range.length);
      const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
      const window = buf.toString('utf-8', 0, bytesRead);
      if (isTail) {
        // In bytes, not characters: these are file offsets a later read resumes from.
        tailFrom = range.start > 0 ? range.start + buf.indexOf(0x0a) + 1 : 0;
        through = range.start + buf.lastIndexOf(0x0a, bytesRead - 1) + 1;
      }
      const lines = window.split('\n');
      // A window that starts mid-file almost certainly starts mid-line.
      if (range.start > 0) lines.shift();
      for (const line of lines) {
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          ev = parsed as Record<string, unknown>;
        } catch { continue; }
        // Two different questions, and they had one answer between them until a `cd` proved
        // otherwise. `cwd` is where the session OPENED, which is its project; `recentCwd` is
        // wherever the agent's shell has wandered to since, which is not.
        // `cwd` from the HEAD only. The tail's is wherever the agent's shell has wandered to,
        // and taking it is how a live session gets filed under one of its own subfolders.
        if (typeof ev.cwd === 'string') {
          if (isHead) out.cwd ??= ev.cwd;
          out.recentCwd = ev.cwd;
        }
        if (typeof ev.gitBranch === 'string') out.gitBranch = ev.gitBranch;
        if (typeof ev.entrypoint === 'string') out.entrypoint = ev.entrypoint;
        if (isHead) titlesOf(line, head);
        if (isTail) titlesOf(line, tail);
        // Last one in the window wins: this is the turn state as of the most
        // recent line that spoke to it.
        if (isTail) {
          const closed = turnClosedFor(ev);
          if (closed !== undefined) out.lastTurnClosed = closed;
        }
        if (isHead) out.firstPrompt ??= promptText(ev);
      }
      // Nothing in the head window parsed and there was no line break in it: one
      // record overran the whole window. What is visible of it is still its front,
      // which is where the prompt is.
      if (isHead && !out.firstPrompt && !window.includes('\n')) {
        out.firstPrompt = promptFromOversizedRecord(window);
      }
    }
    // A head window with no `cwd` in it is not a session without a project, and answering as
    // though it were deleted a working session from the catalog every time its last record was
    // larger than the tail window. Read forward for it instead: this is identity rather than
    // something a row displays, so it is the one fact worth leaving the two windows for.
    if (!out.cwd && ranges.length > 1) {
      out.cwd = await scanForOpeningCwd(fh, HEADER_EDGE_BYTES, metadata.size);
    }
    const titles = await currentTitles(fh, filePath, {
      whole: ranges.length === 1,
      head,
      tail,
      tailFrom,
      through,
    });
    out.title = titles.customTitle ?? titles.aiTitle;
    return out.cwd ? out : null;
  } finally {
    await fh.close();
  }
}

export function filePathToSessionId(p: string): string | null {
  if (!p.endsWith('.jsonl')) return null;
  // Require the path to be under the projects root so the watcher does not claim
  // a Codex rollout that happens to live at <something>/foo.jsonl.
  if (!p.startsWith(config.claudeProjectsDirectory)) return null;
  const sid = basename(p, '.jsonl');
  if (sid.startsWith('_')) return null;
  return sid;
}
