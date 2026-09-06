// The multiplexer's own session list, which is what the terminal grid attaches to.
//
// Why tmux and not the PTY manager's own sessions: the manager can re-attach a process IT
// started, and the sessions worth watching were started by hand from a real terminal. tmux is
// what makes a second viewer of an already-running process legal, so it is the thing to ask.

import { config } from "../config.ts";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";

export class TmuxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxUnavailable";
  }
}

/**
 * One line per session, fields in the order this format string names them.
 *
 * `|` rather than a tab because a session name can contain neither, and reading the format back
 * from the parser is how the two stay in step.
 */
const LIST_FORMAT = "#{session_name}|#{session_windows}|#{session_attached}|#{session_path}";

export function parseTmuxSessions(stdout: string): TmuxSessionSummary[] {
  const sessions: TmuxSessionSummary[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, windows, attached, path] = line.split("|");
    // A line that does not carry every field is a format drift, not a session. Skipping it
    // silently would show a grid with a tile missing and no reason for it.
    if (!name || windows === undefined || attached === undefined || path === undefined) {
      throw new TmuxUnavailable(`tmux list-sessions returned an unreadable line: ${line}`);
    }
    sessions.push({
      name,
      windows: Number(windows) || 0,
      attachedClients: Number(attached) || 0,
      path,
    });
  }
  return sessions;
}

async function tmux(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const bin = config.tmuxPath;
  if (!bin) {
    throw new TmuxUnavailable("no tmux binary found; set AGENT_FEED_TMUX_PATH to an absolute path");
  }
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/**
 * Everything the pane holds, escapes included, newest last.
 *
 * A `tmux attach` draws one screen and nothing more, so a viewer that joined sees only what has
 * changed since. The history it is missing is tmux's, and this is how tmux hands it over. `-e`
 * keeps the colour; `-J` is deliberately absent, since joining wrapped lines would reflow output
 * that was laid out for a different width.
 */
export async function captureTmuxHistory(session: string, lines: number): Promise<string> {
  const { out, err, code } = await tmux([
    "capture-pane", "-p", "-e", "-S", `-${lines}`, "-t", session,
  ]);
  if (code !== 0) throw new TmuxUnavailable(`tmux capture-pane exited ${code}: ${err.trim()}`);
  return historyForTerminal(out);
}

/**
 * Line feeds become carriage-return line feeds, because the destination is a terminal.
 *
 * `capture-pane` writes text, one line per line, separated by LF. A terminal reading a bare LF
 * moves down a row and stays in the column it was in, so every line after the first starts where
 * the previous one ended: the history arrives as a staircase of fragments, each indented by the
 * length of the line above it. Seen exactly that way before this existed.
 */
export function historyForTerminal(captured: string): string {
  return captured.replace(/\r?\n/g, "\r\n");
}

/**
 * Hands the wheel to whoever is viewing, rather than to tmux.
 *
 * With `mouse on` tmux asks its client for mouse reporting, so a browser terminal forwards the
 * wheel to tmux instead of scrolling its own buffer, and tmux answers it by entering copy-mode:
 * the pane freezes, keys stop reaching the agent, and scrolling back is a mode you have to leave.
 * Off, the client scrolls the bytes it already holds. Set per session rather than globally,
 * because a session the panel never shows is none of its business.
 */
export async function releaseTmuxMouse(session: string): Promise<void> {
  const { err, code } = await tmux(["set-option", "-t", session, "mouse", "off"]);
  if (code !== 0) throw new TmuxUnavailable(`tmux set-option mouse exited ${code}: ${err.trim()}`);
}

/** Empty when the server is not running, which is not a failure: nobody has started a session. */
export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const { out, err, code } = await tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (code === 0) return parseTmuxSessions(out);
  // "no server running" is how tmux reports an empty machine, and it exits non-zero saying so.
  if (/no server running|no sessions/i.test(err)) return [];
  throw new TmuxUnavailable(`tmux list-sessions exited ${code}: ${err.trim() || out.trim()}`);
}
