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
import { renameTmuxSession } from "@/input/tmuxComposer";
import { liveTmuxSession } from "@/terminal/agentTerminalService";
import { uniqueTmuxSessionName } from "@/terminal/tmuxSessionNames";
import { listTmuxSessions, renameTmuxSessionTo } from "@/terminal/tmuxSessions";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { sessionTitleRefusal } from "@/transcripts/sessionTitle";

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
  const invalid = sessionTitleRefusal(title);
  if (invalid) throw new SessionRenameInvalidError(invalid);
  if (!findSession("claude", sessionId)) {
    throw new SessionRenameNotFoundError("session not found");
  }

  const outcome = await renameTmuxSession(sessionId, title);
  if (!outcome.renamed) throw new SessionRenameUnavailableError(refusal(outcome.reason));
  await relabelTmuxSession(sessionId, title);
  return title;
}

/**
 * Gives the session's tmux the same name the session just took.
 *
 * The point is `tmux attach -t canvas-session` on the machine the work is running on. A pane used
 * to be named for the session UUID because the name WAS the lookup key -- two viewers computed it
 * independently to converge on one pane -- so it could not be changed without stranding them.
 * Identity now lives in a stamp on the session (`@agentdesk-session`) that rides through renames,
 * which is what makes the name free to be something a person can type.
 *
 * Best effort, and after the rename that matters rather than before it. The session HAS been
 * renamed by this point; failing the call over a label would report a rename that plainly
 * happened as one that did not, and leave the caller with no way to tell which half was true.
 */
async function relabelTmuxSession(sessionId: string, title: string): Promise<void> {
  try {
    const current = await liveTmuxSession("claude", sessionId);
    if (!current) return;
    // Its own name excluded from the taken set: a session renamed in place would otherwise collide
    // with itself and take a suffix for a name that was already free.
    const taken = (await listTmuxSessions())
      .map((session) => session.name)
      .filter((name) => name !== current);
    const next = uniqueTmuxSessionName(title, sessionId, taken);
    if (next !== current) await renameTmuxSessionTo(current, next);
  } catch {
    // No tmux, no pane, or a name tmux refused. The session is renamed either way.
  }
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
