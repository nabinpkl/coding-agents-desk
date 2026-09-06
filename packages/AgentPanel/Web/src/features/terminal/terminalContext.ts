import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";

/**
 * One stable string for what a terminal is pointed at, whichever kind it is.
 *
 * Callers used to compare the three fields of an agent-session context by hand, which stopped
 * compiling the moment a second kind existed and would have stopped being CORRECT before that if
 * a field had ever been added. The key is also what a grid can use as a React key.
 */
export function terminalContextKey(context: AgentTerminalContext): string {
  if (context.kind === "tmux") return `tmux:${context.session}`;
  if (context.kind === "session-tmux") return `session-tmux:${context.source}:${context.sessionId}`;
  // The fork, not its source: two forks of one session are two terminals, and keying them by the
  // session they came from would collapse them into one.
  if (context.kind === "session-fork") return `session-fork:${context.forkId}`;
  return `${context.source}:${context.projectPath}:${context.sessionId}`;
}

/**
 * What to call this terminal on screen.
 *
 * The session-backed kind says so, rather than reading as the plain provider name: both it and a
 * resumed CLI can be open at once -- the thread's own terminal in the composer while the Terminals
 * surface holds a shell in the same project -- and two regions with one name is a screen reader
 * announcing the same thing twice for different things.
 */
export function terminalContextLabel(context: AgentTerminalContext): string {
  if (context.kind === "tmux") return context.session;
  const provider = context.source === "claude" ? "Claude" : "Codex";
  if (context.kind === "session-fork") return `${provider} fork`;
  return context.kind === "session-tmux" ? `${provider} session` : provider;
}

/**
 * Whether the far end is a tmux pane rather than a PTY session of the viewer's own.
 *
 * Asked in four places, and every one of them was written as `kind === "tmux"` before a second
 * tmux-backed kind existed -- geometry ownership, history import, replay, and how a viewer leaves.
 * They are all the same question, so it is asked once here: a predicate that misses a kind is a
 * terminal that resizes somebody's live session or replays over its imported history.
 */
export function isTmuxAttach(context: AgentTerminalContext): boolean {
  return context.kind === "tmux"
    || context.kind === "session-tmux"
    || context.kind === "session-fork";
}
