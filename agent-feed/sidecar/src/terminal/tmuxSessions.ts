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
 * What tmux is asked for: the scrollback, and deliberately NOT the screen.
 *
 * tmux numbers the visible screen from 0 and the scrollback with negatives, so `-E -1` ends the
 * range one line above the top of the screen. The screen is excluded because the live stream is
 * about to paint it: a viewer that also imports it as text writes a second, frozen copy, and
 * tmux's redraw then addresses screen rows absolutely into a window that overlaps that copy.
 * Measured on a pane holding 1066 scrollback lines: `-S -50000` returned 1089, the extra 23 being
 * the screen, and the redraw landing one row out left half-overwritten lines through the history.
 *
 * `-e` keeps the colour. `-J` is deliberately absent, since joining wrapped lines would reflow
 * output that was laid out for a different width.
 */
export function captureHistoryArgs(session: string, lines: number): string[] {
  return ["capture-pane", "-p", "-e", "-S", `-${lines}`, "-E", "-1", "-t", session];
}

/** The visible screen on its own, which is the part the scrollback range deliberately omits. */
export function captureScreenArgs(session: string): string[] {
  return ["capture-pane", "-p", "-e", "-t", session];
}

/** How tall that screen is, which is how many rows the viewer has to open for it. */
export function paneHeightArgs(session: string): string[] {
  return ["display-message", "-p", "-t", session, "#{pane_height}"];
}

/**
 * Scrollback, then a screen's worth of blank rows, then the screen painted into them.
 *
 * The blank rows are the whole point, and they are not padding. A terminal's active screen is
 * always the last `rows` lines of its buffer, and tmux addresses that screen absolutely: row 1 is
 * row 1 whatever is under it. Write the scrollback and stop, and the screen window still straddles
 * the last rows of that scrollback, so tmux's next repaint overwrites part of each of those lines
 * and leaves the rest -- history that reads as corruption rather than as a positioning bug. Opening
 * `rows - 1` lines (the scrollback's own trailing newline is the first) puts the window entirely on
 * blank rows below the history, and `ESC[H` homes into it before the screen text fills it exactly.
 *
 * Composed here rather than in the viewer because the row count that has to match is the pane's,
 * and the pane is what this module can see.
 */
export function terminalHistoryPayload(
  { scrollback, screen, rows }: { scrollback: string; screen: string; rows: number },
): string {
  const history = historyForTerminal(scrollback);
  const opening = "\r\n".repeat(Math.max(0, rows - 1));
  return `${history}${opening}\u001b[H${historyForTerminal(screen.replace(/\n$/, ""))}`;
}

function demand(what: string, result: { err: string; code: number }): void {
  if (result.code === 0) return;
  throw new TmuxUnavailable(`tmux ${what} read exited ${result.code}: ${result.err.trim()}`);
}

/** Everything the viewer needs to open with: the pane's scrollback and its current screen. */
export async function captureTmuxHistory(session: string, lines: number): Promise<string> {
  const [history, screen, height] = await Promise.all([
    tmux(captureHistoryArgs(session, lines)),
    tmux(captureScreenArgs(session)),
    tmux(paneHeightArgs(session)),
  ]);
  // Named individually because the three are different commands: a reader told "capture-pane
  // failed" when it was `display-message` that failed looks for the bug in the wrong place.
  demand("scrollback", history);
  demand("screen", screen);
  demand("pane height", height);
  const rows = Number.parseInt(height.out.trim(), 10);
  if (!Number.isInteger(rows) || rows < 1) {
    throw new TmuxUnavailable(`tmux reported an unusable pane height: ${height.out.trim()}`);
  }
  return terminalHistoryPayload({ scrollback: history.out, screen: screen.out, rows });
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
 * Gives the session's mouse setting back to whoever configured it.
 *
 * This used to force `mouse off`, so that a browser terminal's wheel scrolled its own buffer
 * instead of being forwarded to tmux and answered with copy-mode. The cost was not the panel's to
 * pay: `mouse` is a session option with no per-client form, so one tile opening quietly took
 * copy-mode, wheel scrollback and mouse selection away from every other client of that session,
 * including the terminal the owner has it open in. `-u` unsets the session-local value so the
 * session inherits the global one again, which also repairs a session an older build clobbered.
 *
 * The viewer keeps its own scrolling regardless, because its wheel handler consumes the event
 * rather than letting xterm forward it.
 */
export async function restoreTmuxMouse(session: string): Promise<void> {
  const { err, code } = await tmux(["set-option", "-u", "-t", session, "mouse"]);
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
