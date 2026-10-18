// Which tmux session a live process for a session id is running inside, if any.
//
// Its own file because it is the other half of what `agentTerminalIdentity.ts` answers: that
// file decides what a terminal is pointed at from a request, and this one reads the machine --
// the process registry and the identity stamp on the tmux session itself -- to say where a
// session already runs. The service re-exports it, so the callers that ask "where is this
// session" never moved.

import { claudeSessionPaneName } from "@/terminal/session-panes/claudeSessionLaunch";
import { findTmuxSessionByIdentity } from "@/terminal/tmux/tmuxSessions";
import { currentProcessTable } from "@/tasks/processProbe";
import { liveSessionProcesses } from "@/tasks/sessionRegistry";

/**
 * The tmux session a live process for that session id is running inside, if any.
 *
 * Claude only: its harness is what writes the process registry this reads, so a Codex session has
 * nothing to look up and answers "none" -- which lands it on the resume path, the same place a
 * Claude session that is not running lands. Opencode answers from the identity stamp alone: the
 * serve keeps no process registry, but a pane this sidecar started carries the session id on the
 * tmux session itself, which survives the relabel to the session's title.
 *
 * More than one row can claim one session id, and routinely does: a session resumed by the path
 * below registers itself under the same id as the session it resumed, so from the second open
 * onwards there are two panes to choose from. Measured on this machine with three rows for one id.
 * Somebody else's terminal wins, and the one this sidecar started is the fallback -- picking by
 * registry order would move a thread's terminal between two panes for no visible reason.
 */
/**
 * Whether a live Claude process holds that session, in tmux or anywhere else.
 *
 * Asked before a session's own pane is given `claude --resume` again: the registry is the only
 * record of a process outside tmux -- a Claude Desktop window, a terminal the stamp does not name --
 * and resuming under one of those would open a second client on one transcript.
 */
export async function claudeSessionRunning(
  sessionId: string,
  processes: () => Promise<{ sessionId: string }[]> = async () => liveSessionProcesses(await currentProcessTable()),
): Promise<boolean> {
  return (await processes()).some((entry) => entry.sessionId === sessionId);
}

export async function liveTmuxSession(
  source: "claude" | "codex" | "opencode",
  sessionId: string,
  processes: () => Promise<{ sessionId: string; tmuxSession: string | null }[]> = async () =>
    liveSessionProcesses(await currentProcessTable()),
  stamped: (sessionId: string) => Promise<string | null> = findTmuxSessionByIdentity,
): Promise<string | null> {
  if (source === "codex") return null;
  if (source === "opencode") return stamped(sessionId).catch(() => null);
  if (source !== "claude") return null;
  // The stamp first, because the registry's answer is a NAME the CLI resolved once at startup and
  // then cached. It never re-reads it, so a renamed session leaves that row pointing at a name
  // tmux no longer has -- measured: `has-session` on it exits 1 while the pane sits there running.
  // The stamp is set on the tmux session itself and rides through any number of renames.
  const byStamp = await stamped(sessionId).catch(() => null);
  if (byStamp) return byStamp;
  const panes = (await processes())
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.tmuxSession)
    .filter((pane): pane is string => pane !== null);
  // Still meaningful after panes started being renamed to their titles, though it reads as though
  // it should not be: a pane only gives up this name once its stamp reads back, so reaching here at
  // all -- the stamp having answered nothing -- means the sidecar's own pane is still called this.
  return panes.find((pane) => pane !== claudeSessionPaneName(sessionId)) ?? panes[0] ?? null;
}
