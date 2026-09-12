/**
 * Renaming a Claude session, by writing the record the CLI writes.
 *
 * A session has two names and only one of them can be set from outside the process. `-n` sets the
 * registry `name` that `ListAgents` and cross-session messaging address, and nothing can change
 * that after the session starts. The transcript's `custom-title` record is the other one: it is
 * what `/resume` shows, what the catalog reads, and therefore what the panel puts on a row.
 *
 * Appending it is the whole mechanism. The header read takes the file's first and last 32 KB and
 * ranks `customTitle` above the harness's generated `aiTitle`, so a record at the end of the file
 * is the one that wins on the next read -- and the file watcher schedules that read itself. There
 * is no API to call and no process to notify.
 */
import { appendFile, open } from "node:fs/promises";
import {
  findSession,
  refreshClaudeSession,
  SUMMARY_TITLE_CHARACTERS,
} from "./transcriptCatalog.ts";

export class SessionRenameInvalidError extends Error {}
export class SessionRenameNotFoundError extends Error {}

/**
 * Writes a new title for one Claude session and returns what was written.
 *
 * Claude only. Codex keeps its titles in a database this does not own, so a rename there would be
 * a different mechanism wearing the same name.
 */
export async function renameClaudeSession(
  sessionId: string,
  requestedTitle: string,
): Promise<string> {
  const title = requestedTitle.trim();
  if (!title) throw new SessionRenameInvalidError("a session title cannot be empty");
  // The catalog's own cap, not a second one: a longer title would be written to the transcript and
  // then read back truncated, so the row would not say what the reader typed.
  if (title.length > SUMMARY_TITLE_CHARACTERS) {
    throw new SessionRenameInvalidError(
      `a session title cannot exceed ${SUMMARY_TITLE_CHARACTERS} characters`,
    );
  }
  // One record is one line, so a title carrying a line break would split into a second record that
  // parses as nothing. Refused rather than stripped: the reader typed it and should see why.
  if (/[\n\r]/.test(title)) {
    throw new SessionRenameInvalidError("a session title cannot contain a line break");
  }
  const session = findSession("claude", sessionId);
  if (!session) throw new SessionRenameNotFoundError("session not found");

  // Exactly the CLI's own shape, verified against the records already in this machine's
  // transcripts: three fields and no timestamp.
  const record = JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
  await appendRecord(session.transcriptPath, record);
  // Not left to the watcher, which will also fire and land the same row. The catalog is what the
  // panel's next read answers from, and the write is already done: waiting on a file event to
  // make it visible would leave a window where the session list still says the old name.
  await refreshClaudeSession(session.transcriptPath);
  return title;
}

/**
 * Appends one JSONL record, starting a line first if the file does not end on one.
 *
 * A transcript normally ends with a newline, but one whose writer died mid-record does not -- and
 * appending straight onto that partial line would fuse the two into a record that parses as
 * nothing, destroying whatever the CLI had written.
 *
 * The write itself stays an `O_APPEND` one rather than a seek to a measured offset, so it cannot
 * land in the middle of a record the CLI is writing concurrently. That leaves one harmless race:
 * the CLI appends between the read and the write, and the leading newline lands on a file that no
 * longer needs it. The result is a blank line, which every reader of this format skips.
 */
async function appendRecord(filePath: string, record: string): Promise<void> {
  await appendFile(filePath, `${(await endsOnNewline(filePath)) ? "" : "\n"}${record}\n`, "utf-8");
}

/** Whether the file's last byte is a newline. An empty file counts as ending on one. */
async function endsOnNewline(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, size - 1);
    return tail[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
