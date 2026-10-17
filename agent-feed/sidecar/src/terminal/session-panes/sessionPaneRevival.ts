// What a session's own pane runs again when the harness it was started with has exited.
//
// Its own file because it is a decision about the harness, not about which pane a target names:
// `agentTerminalIdentity.ts` finds the pane, this says whether joining it should bring the session
// back to life in it, and `reviveExitedPane` says whether the pane in front of it qualifies.

import { opencodeBinary } from "@/config/configBinaries";
import { resumeClaudeSessionCommand } from "@/terminal/session-panes/claudeSessionLaunch";
import type { PaneRevival } from "@/terminal/tmux/tmuxSessions";

/**
 * The argv that opens the opencode TUI on one session, or null when this machine has no opencode.
 *
 * By absolute path, not the bare name `claude` gets away with: opencode's installer adds its
 * directory to PATH in the interactive shell's rc file only, and a pane runs its command through a
 * login shell, so `opencode` there is `zsh:1: command not found: opencode`. Measured on two Bot
 * sessions (2026-10-13), each pane left at a shell where a bare `opencode` typed by hand then
 * opened a NEW session instead of this one -- the card showing nothing while the pane worked.
 */
export function opencodeTuiCommand(sessionId: string): string[] | null {
  const binary = opencodeBinary();
  return binary ? [binary, "--session", sessionId] : null;
}

/**
 * What a joined pane runs again if the command it was started with has exited, or null for none.
 *
 * A session's pane is found by its identity stamp, which outlives the process inside it, so without
 * this a pane whose harness exited -- quit, crashed, or never started -- is joined as a bare shell
 * for good.
 *
 * Claude only while no live process holds the session ANYWHERE: a Claude Desktop window, or a
 * terminal the stamp does not name. Resuming then would open a second client on one transcript,
 * which is why the resume path is the fallback to a live owner rather than the first move. Opencode
 * needs no such check: its serve owns the session, so a second TUI is a second viewer of it.
 */
export async function sessionPaneRevival(
  source: "claude" | "codex" | "opencode",
  sessionId: string,
  cwd: string,
  claudeRunning: (sessionId: string) => Promise<boolean>,
): Promise<PaneRevival | null> {
  if (source === "opencode") {
    const tui = opencodeTuiCommand(sessionId);
    return tui ? { startedFor: sessionId, cwd, command: tui } : null;
  }
  if (source !== "claude" || await claudeRunning(sessionId)) return null;
  return { startedFor: sessionId, cwd, command: resumeClaudeSessionCommand(sessionId) };
}
