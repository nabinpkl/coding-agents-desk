// Starting an opencode session's TUI in its own pane, at the moment the session is made.
//
// Until this, an opencode session got a pane only when a terminal first joined it
// (`agentTerminalIdentity.ts`), which is right for a session somebody else made and wrong for one a
// reader just asked for in a pane: they want to watch it start, and nothing else would start it.
//
// The same three decisions that join makes, made once here rather than copied: the pane is BORN
// under `opencodeSessionPaneName`, it runs `opencodeTuiCommand`, and it is stamped with the session
// so the join finds this pane later rather than starting a second TUI beside it.

import { opencodeSessionPaneName } from "@/terminal/agentTerminalIdentity";
import { UNATTENDED_COLUMNS, UNATTENDED_ROWS } from "@/terminal/claudeSessionLaunch";
import { opencodeTuiCommand } from "@/terminal/sessionPaneRevival";
import { createTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { adoptTitleName } from "@/terminal/tmux/tmuxRelabel";

export class OpencodeUnavailableError extends Error {}

/**
 * Starts the TUI on one session in a detached pane, answering the name the pane ended up with.
 *
 * Throws `OpencodeUnavailableError` when this machine has no opencode binary, which a caller asks
 * BEFORE creating the session at the serve so a missing binary costs a refusal, not a session
 * with no pane.
 */
export async function startOpencodeSessionPane(options: {
  sessionId: string;
  cwd: string;
  title: string;
}): Promise<string> {
  const command = opencodeTuiCommand(options.sessionId);
  if (!command) throw new OpencodeUnavailableError("opencode is not installed on this machine");
  const pane = opencodeSessionPaneName(options.sessionId);
  await createTmuxSession({
    session: pane,
    cwd: options.cwd,
    command,
    columns: UNATTENDED_COLUMNS,
    rows: UNATTENDED_ROWS,
  });
  return adoptTitleName(pane, options.sessionId, options.title);
}
