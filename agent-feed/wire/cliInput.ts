// Typing into a Claude Code session that is already running in someone's terminal.
//
// Not the same act as sending to an agent the panel owns. A session created through
// `/api/agent-sessions` is ours: we spawned it, we hold its stream, and a send is a call. A CLI
// session belongs to a human at a keyboard, and the only thing the panel can do is put a turn in
// its inbox the way another process would. The vocabulary below is deliberately thinner than
// `AgentCommandReceipt` for that reason: no queue position, no run state, no abort.
//
// The transport is the harness's own per-session unix socket, so nothing here is window- or
// terminal-shaped. It carries no window id and no reason mentioning focus, because delivery does
// not need the session to be visible, on this Desktop, or in a terminal that can be scripted.

/** How the harness says a live session was launched. `cli` is the one this feature is for. */
export type ClaudeSessionEntrypoint = "cli" | "claude-desktop" | "other";

/**
 * Why a session cannot be typed into.
 *
 * Worth distinguishing in the panel, because the fixes differ: `not-running` is fixed by opening
 * the session, `no-inbox` never will be on this build, and `unreachable` usually means the
 * process died between the registry read and the connect.
 */
export type CliInputUnavailableReason =
  /** No live process is serving this session id. */
  | "not-running"
  /** A live process, but it publishes no messaging socket -- an older harness, or the gate is off. */
  | "no-inbox"
  /** The socket is published but its auth key is missing or unreadable, so we cannot identify. */
  | "no-key"
  /** The socket exists and nothing is listening on it. A stale file left by a dead session. */
  | "unreachable"
  /**
   * The socket was there and the handoff still did not finish: the write timed out, the peer
   * closed on an error, or the connection failed in a way that was not a stale socket. Rare, and
   * kept separate from `unreachable` because it is the one reason worth simply retrying.
   */
  | "delivery-failed";

/** Whether this session can be typed into right now, and how it was launched. */
export interface CliInputStatus {
  available: boolean;
  /** null when nothing live is serving the session, which is also when `available` is false. */
  entrypoint: ClaudeSessionEntrypoint | null;
  reason: CliInputUnavailableReason | null;
}

/**
 * What one delivery attempt achieved.
 *
 * `delivered` means the turn reached the session's inbox, NOT that the session has acted on it.
 * The harness may hold a peer's message for the user's approval, and it reports that verdict to
 * the sender's own inbox rather than on the connection that delivered it -- we have no inbox, so
 * there is no verdict to report and this type does not pretend otherwise. What happened next is
 * visible where it is anyway: in the transcript the panel is already streaming.
 */
export interface CliInputReceipt {
  delivered: boolean;
  reason: CliInputUnavailableReason | null;
}
