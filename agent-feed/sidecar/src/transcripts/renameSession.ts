/**
 * Renaming a Claude session, by asking the session to rename itself.
 *
 * A session has two names. The transcript's `custom-title` record is the TITLE: what `/resume`
 * shows, what the catalog reads, and what the panel puts on a row. The registry's `name` is the
 * ADDRESS: what `ListAgents` prints and what cross-session messaging delivers to.
 *
 * Claude's own `/rename` moves both. Writing the transcript from outside moves only the title, so
 * a session renamed that way keeps answering to its old name for every other agent looking for
 * it -- which is most of the reason to rename one at all. That is why this drives the CLI rather
 * than editing the file the CLI owns: the complete rename is the only one worth offering, and one
 * writer per transcript is the version with no concurrency question in it.
 *
 * The cost is that a session with no running process cannot be renamed, and there is deliberately
 * no fallback to writing the record. A half rename that silently leaves the address behind is the
 * outcome this exists to avoid, so it is refused with a reason instead.
 */
import { renameTmuxSession } from "../input/tmuxComposer.ts";
import { findSession, SUMMARY_TITLE_CHARACTERS } from "./transcriptCatalog.ts";

export class SessionRenameInvalidError extends Error {}
export class SessionRenameNotFoundError extends Error {}
/** The session is there and was not renamed: no pane to ask, or a composer with text in it. */
export class SessionRenameUnavailableError extends Error {}

/**
 * Renames one Claude session and returns the title it was given.
 *
 * Claude only. Codex has no equivalent command and keeps its titles in a database this does not
 * write, so a rename there would be a different mechanism wearing the same name.
 */
export async function renameClaudeSession(
  sessionId: string,
  requestedTitle: string,
): Promise<string> {
  const title = requestedTitle.trim();
  if (!title) throw new SessionRenameInvalidError("a session title cannot be empty");
  // The catalog's own cap, not a second one: a longer title would be stored and then read back
  // truncated, so the row would not say what the reader typed.
  if (title.length > SUMMARY_TITLE_CHARACTERS) {
    throw new SessionRenameInvalidError(
      `a session title cannot exceed ${SUMMARY_TITLE_CHARACTERS} characters`,
    );
  }
  // `/rename` takes its title to the end of one line, so a line break would end the command early
  // and leave the rest sitting in the composer as text.
  if (/[\n\r]/.test(title)) {
    throw new SessionRenameInvalidError("a session title cannot contain a line break");
  }
  if (!findSession("claude", sessionId)) {
    throw new SessionRenameNotFoundError("session not found");
  }

  const outcome = await renameTmuxSession(sessionId, title);
  if (!outcome.renamed) throw new SessionRenameUnavailableError(refusal(outcome.reason));
  return title;
}

/** Why the rename did not happen, in terms of what the reader can do about it. */
function refusal(reason: string | null): string {
  if (reason === "composer-busy") {
    return "this session has unsent text in its composer; send or clear it and rename again";
  }
  if (reason === "no-pane") {
    return "this session is not running, and only a running session can rename itself";
  }
  if (reason === "no-composer") {
    return "this session's terminal is not showing a composer to type in";
  }
  if (reason === "tmux-unavailable") return "this session's terminal could not be reached";
  return "this session could not be renamed";
}
