import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";

/**
 * One stable string for what a terminal is pointed at, whichever kind it is.
 *
 * Callers used to compare the three fields of an agent-session context by hand, which stopped
 * compiling the moment a second kind existed and would have stopped being CORRECT before that if
 * a field had ever been added. The key is also what a grid can use as a React key.
 */
export function terminalContextKey(context: AgentTerminalContext): string {
  return context.kind === "tmux"
    ? `tmux:${context.session}`
    : `${context.source}:${context.projectPath}:${context.sessionId}`;
}

/** What to call this terminal on screen. */
export function terminalContextLabel(context: AgentTerminalContext): string {
  return context.kind === "tmux" ? context.session : context.source === "claude" ? "Claude" : "Codex";
}
