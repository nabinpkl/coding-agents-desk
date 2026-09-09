// Starting a Claude session in a tmux pane this sidecar owns.
//
// There are two callers and they must not disagree. The panel's new-session terminal starts one
// because a reader asked for a pane; the Bot roster starts one because a Bot is being created
// around a directory. Both need the same three decisions -- which pane name, which argv, and the
// identity stamp that survives a rename -- and the pane name in particular is not cosmetic: a
// session started in a pane named anything else is one the card's terminal will not join, so
// opening it would resume the transcript a second time beside the process still writing it.

import {
  createTmuxSession,
  stampTmuxSessionIdentity,
} from "./tmuxSessions.ts";

/**
 * The pane a session started or resumed by this sidecar runs in.
 *
 * Derived from the session id rather than the title, because it is the meeting point of two
 * lookups that never speak: a second viewer of one session has only the id, and must land on the
 * pane the first one made. The friendly names in `tmuxSessionNames.ts` are for panes a person
 * types at; this one is addressed by machines.
 *
 * It is also what makes a session survive becoming real. A session started here has no transcript
 * and no catalog row, and the ordinary "watch this session" path goes looking for a pane by this
 * name once the catalog knows the id -- so the pane it was started in is the pane that path finds.
 * Give it a name of its own and the card's terminal jumps to a second pane the moment the session
 * exists, or worse, resumes the transcript beside the process still writing it.
 */
export function claudeSessionPaneName(sessionId: string): string {
  return `agentdesk-${sessionId}`;
}

/**
 * The argv that starts a fresh Claude session at a known id.
 *
 * `--session-id` stands alone, without `--resume` (measured against the CLI's own help on
 * 2026-09-08). It is what makes the transcript land at an id the caller already knows, which is
 * the only way to recognise the session before its first turn has written anything.
 *
 * `-n` sets the ADDRESS as well as the title: it is written to the session registry as `name`,
 * which is what other agents can send to. A session started without one is indistinguishable
 * from every other in a listing.
 *
 * The prompt is a positional argument, which is how the CLI takes a first turn. It goes through
 * the same per-argument shell quoting as everything else on this path (`newSessionArgs`), so a
 * brief carrying quotes, parentheses or newlines arrives whole.
 */
export function newClaudeSessionCommand(
  options: { sessionId: string; title: string; prompt?: string },
): string[] {
  const command = ["claude", "--session-id", options.sessionId, "-n", options.title];
  if (options.prompt) command.push(options.prompt);
  return command;
}

/**
 * Geometry for a pane no viewer has opened yet.
 *
 * A detached `new-session` is 80x24, and the CLI's first render is the one that lands in
 * scrollback forever -- a viewer attaching later resizes the pane but cannot reflow what was
 * already drawn. Wide enough that the opening turn reads, not so wide that it wraps oddly when a
 * narrow viewer does attach.
 */
const UNATTENDED_COLUMNS = 120;
const UNATTENDED_ROWS = 40;

export interface StartedClaudeSession {
  sessionId: string;
  title: string;
  tmuxSession: string;
}

/**
 * Starts a session in its own detached pane, with nobody watching.
 *
 * The stamp is best effort for the same reason it is on the terminal path: it makes the pane
 * findable after a rename, and a session that is running is worth more than one refused because
 * its label could not be written.
 */
export async function startClaudeSession(options: {
  cwd: string;
  sessionId: string;
  title: string;
  prompt?: string;
}): Promise<StartedClaudeSession> {
  const tmuxSession = claudeSessionPaneName(options.sessionId);
  await createTmuxSession({
    session: tmuxSession,
    cwd: options.cwd,
    command: newClaudeSessionCommand(options),
    columns: UNATTENDED_COLUMNS,
    rows: UNATTENDED_ROWS,
  });
  await stampTmuxSessionIdentity(tmuxSession, options.sessionId).catch(() => {});
  return { sessionId: options.sessionId, title: options.title, tmuxSession };
}
