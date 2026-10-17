// What the panel knows about a Claude Code session that is running as a CLI process.
//
// Read-only. The panel used to put a turn into such a session through the harness's own
// per-session messaging socket (ADR-0107). That was removed on 2026-10-16: a turn written there
// arrives as a message from another session, "not from your user", and it needed the session's
// messaging key read out of Claude Code's own registry. A session the panel can type into is one
// running in a tmux pane, through the pane's mirrored composer; hub messages reach a session
// through the agentdesk-hub mod. What remains is the one fact that decides which composer to
// offer: whether the session is a terminal CLI process at all, and which pane it runs in.

/**
 * How the harness says a live session was launched. `cli` is a terminal session; `sdk-cli` is a
 * session run through the Agent SDK by this sidecar's runner (ADR-0143), typed into through the
 * runner rather than a pane.
 */
export type ClaudeSessionEntrypoint = "cli" | "sdk-cli" | "claude-desktop" | "other";

/** How a live Claude session was launched, and the tmux pane it runs in. */
export interface CliSessionStatus {
  /** null when nothing live is serving the session. */
  entrypoint: ClaudeSessionEntrypoint | null;
  /** The tmux session the live process is running inside, or null. */
  tmuxSession: string | null;
}
