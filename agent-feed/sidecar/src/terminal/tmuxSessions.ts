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

/**
 * How tall that screen is, and where the cursor sits in it.
 *
 * The height says how many rows the viewer has to open. The cursor says where to leave it, which
 * matters because the program on the other end goes on drawing RELATIVE to it: Claude Code's
 * renderer redraws by moving from where it believes the cursor is. Measured on a live pane: a
 * viewer that ended its import at the end of the captured text left the cursor several rows below
 * the composer, and every subsequent keystroke was echoed onto the status divider instead of into
 * the box -- correct bytes, correct terminal, wrong origin.
 */
export function paneGeometryArgs(session: string): string[] {
  return [
    "display-message", "-p", "-t", session, "#{pane_height} #{cursor_y} #{cursor_x}",
  ];
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
 * It ends by putting the cursor where the pane's actually is, rather than wherever the screen text
 * happened to run out. See `paneGeometryArgs`.
 *
 * Composed here rather than in the viewer because the row count that has to match is the pane's,
 * and the pane is what this module can see.
 */
export function terminalHistoryPayload(
  { scrollback, screen, rows, cursor }: {
    scrollback: string;
    screen: string;
    rows: number;
    /** The pane's cursor, zero-based as tmux reports it. */
    cursor: { row: number; column: number };
  },
): string {
  const history = historyForTerminal(scrollback);
  const opening = "\r\n".repeat(Math.max(0, rows - 1));
  // CUP is one-based, and addresses the screen -- which the opening rows above put exactly where
  // the pane's screen is.
  const home = `\u001b[${cursor.row + 1};${cursor.column + 1}H`;
  return `${history}${opening}\u001b[H${historyForTerminal(screen.replace(/\n$/, ""))}${home}`;
}

function demand(what: string, result: { err: string; code: number }): void {
  if (result.code === 0) return;
  throw new TmuxUnavailable(`tmux ${what} read exited ${result.code}: ${result.err.trim()}`);
}

/** Everything the viewer needs to open with: the pane's scrollback and its current screen. */
export async function captureTmuxHistory(session: string, lines: number): Promise<string> {
  const [history, screen, geometry] = await Promise.all([
    tmux(captureHistoryArgs(session, lines)),
    tmux(captureScreenArgs(session)),
    tmux(paneGeometryArgs(session)),
  ]);
  // Named individually because the three are different commands: a reader told "capture-pane
  // failed" when it was `display-message` that failed looks for the bug in the wrong place.
  demand("scrollback", history);
  demand("screen", screen);
  demand("pane geometry", geometry);
  const fields = geometry.out.trim().split(/\s+/);
  const rows = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isInteger(rows) || rows < 1) {
    throw new TmuxUnavailable(`tmux reported an unusable pane height: ${geometry.out.trim()}`);
  }
  // A tmux old enough not to report a cursor still gets a correct screen; it just resumes from the
  // top of it, which is the behaviour this replaces rather than a new failure.
  const coordinate = (field: string | undefined): number => {
    const value = Number.parseInt(field ?? "", 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  };
  return terminalHistoryPayload({
    scrollback: history.out,
    screen: screen.out,
    rows,
    cursor: { row: coordinate(fields[1]), column: coordinate(fields[2]) },
  });
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

/**
 * Whether that exact session is running.
 *
 * `=` before the name is load-bearing: tmux resolves a bare `-t name` by exact match, then
 * prefix, then fnmatch, so `has-session -t agentdesk-x` answers yes for `agentdesk-xy`. Asked in
 * order to decide whether to CREATE a session, a prefix hit means silently attaching a viewer to
 * somebody else's pane, so this one asks exactly.
 */
export function hasSessionArgs(session: string): string[] {
  return ["has-session", "-t", `=${session}`];
}

export async function tmuxSessionExists(session: string): Promise<boolean> {
  const { out, err, code } = await tmux(hasSessionArgs(session));
  if (code === 0) return true;
  // Both "no server running" and "can't find session" are ordinary answers to the question.
  if (/no server running|can.t find session|no such session|session not found/i.test(err + out)) {
    return false;
  }
  throw new TmuxUnavailable(`tmux has-session exited ${code}: ${err.trim() || out.trim()}`);
}

/**
 * Starts a detached session running one command, at the size the viewer asked for.
 *
 * The geometry is passed because this session has no other client to take it from: a detached
 * `new-session` defaults to 80x24, and the viewer would then be reading a pane narrower than
 * itself for the life of the session. A session tmux was already running keeps its own size --
 * that one has an owner whose terminal decides it.
 *
 * The command goes through a login shell rather than straight to tmux, for the same reason the PTY
 * path does: tmux hands a shell-command to `/bin/sh -c`, and this process's environment is
 * deliberately stripped of the PATH that would find `claude`. It is built here as one string, from
 * a fixed executable name and an argument this module's callers have already validated as a UUID.
 */
export function newSessionArgs(
  { session, cwd, command, columns, rows }: NewTmuxSession,
): string[] {
  // Not `exec`: when the command exits -- a resume that is refused prints why and stops -- the
  // shell stays, so the pane holds the reason where the viewer can read it instead of the session
  // vanishing and the attach failing with nothing to show.
  const script = `${command.join(" ")}; exec ${LOGIN_SHELL} -l`;
  return [
    // `-A` for the race: two viewers of one session can both find it missing, and without this the
    // loser gets "duplicate session" where it wanted the winner's. With it, a second create is a
    // no-op that exits 0, and the caller's own existence check stays as the ordinary path.
    "new-session", "-A", "-d", "-s", session, "-c", cwd,
    "-x", String(columns), "-y", String(rows),
    `${LOGIN_SHELL} -l -c ${shellQuote(script)}`,
  ];
}

export async function createTmuxSession(options: NewTmuxSession): Promise<void> {
  const { err, code } = await tmux(newSessionArgs(options));
  if (code !== 0) {
    throw new TmuxUnavailable(`tmux new-session exited ${code}: ${err.trim()}`);
  }
}

export interface NewTmuxSession {
  session: string;
  cwd: string;
  /** Argv of the command to run, executable first. */
  command: readonly string[];
  columns: number;
  rows: number;
}

const LOGIN_SHELL = "/bin/zsh";

/** Single-quoted for `sh -c`, with the one escape single quotes have. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\''")}'`;
}

/** Empty when the server is not running, which is not a failure: nobody has started a session. */
export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const { out, err, code } = await tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (code === 0) return parseTmuxSessions(out);
  // "no server running" is how tmux reports an empty machine, and it exits non-zero saying so.
  if (/no server running|no sessions/i.test(err)) return [];
  throw new TmuxUnavailable(`tmux list-sessions exited ${code}: ${err.trim() || out.trim()}`);
}

/** The pane's pid and geometry, in one query, for the descriptor the panel renders. */
export async function describeTmuxPane(
  session: string,
): Promise<{ pid: number; columns: number; rows: number }> {
  const { out, err, code } = await tmux([
    "display-message", "-p", "-t", session, "#{pane_pid}|#{pane_width}|#{pane_height}",
  ]);
  if (code !== 0) throw new TmuxUnavailable(`tmux display-message exited ${code}: ${err.trim()}`);
  const parsed = out.trim().split("|").map((value) => Number.parseInt(value, 10));
  const [pid, columns, rows] = parsed;
  if (parsed.length !== 3
    || pid === undefined || columns === undefined || rows === undefined
    || !Number.isInteger(pid) || !Number.isInteger(columns) || !Number.isInteger(rows)) {
    throw new TmuxUnavailable(`tmux reported an unreadable pane: ${out.trim()}`);
  }
  return { pid, columns, rows };
}

/**
 * Bytes into the pane.
 *
 * Hex via `send-keys -H`, because the viewer sends a terminal's byte stream -- printable text,
 * escape sequences for the arrows, bare control characters -- and every key-NAME mapping is a table
 * with holes in it where the composer's keys are.
 */
export async function hexSend(session: string, bytes: Uint8Array): Promise<void> {
  await sendTmuxBytes(session, [...bytes].map((byte) => byte.toString(16).padStart(2, "0")));
}

/** The hex form, for a caller that already has it. */
export async function sendTmuxBytes(session: string, hex: readonly string[]): Promise<void> {
  if (hex.length === 0) return;
  const { err, code } = await tmux(["send-keys", "-H", "-t", session, ...hex]);
  if (code !== 0) throw new TmuxUnavailable(`tmux send-keys exited ${code}: ${err.trim()}`);
}

/**
 * The pane's raw output, live, delivered to `onData` until the returned function is called.
 *
 * Over a loopback socket that tmux connects to with bash's `/dev/tcp`, which is the only shape
 * tried that cannot outlive this process. The obvious alternatives both leak:
 *
 *   A FIFO plus a `cat` child of ours was measured leaking on every `bun --watch` reload -- the
 *   reload drops module state without running any cleanup (no exit event, no signal), so the child
 *   kept the pipe open, the pane stayed piped, and five stale directories and two orphaned readers
 *   were left behind in one session with nothing able to notice.
 *
 *   A plain file grows without bound and still leaves the pane piped.
 *
 * A socket inverts the lifetime: when this process goes, the socket closes, tmux's writer fails on
 * its next write and exits, and tmux clears `pane_pipe` itself. Nothing has to remember to tidy up.
 *
 * What it does NOT fix is a `bun --watch` reload, because that keeps the process and only drops
 * module state -- so the writer is orphaned with its socket still open, and this map no longer
 * knows about it. Measured: one orphaned writer per reload with a tile open. It is bounded rather
 * than unbounded, which is the difference from the FIFO version: the next `open` of that session
 * replaces the pipe command and the old writer dies on its next write, and a socket that nobody
 * drains fills and fails on its own. One idle bash until then, and no temp directory at all.
 *
 * The listener is closed the moment tmux connects, so the window in which anything else on this
 * machine could take that port's one connection is the length of a `pipe-pane` call. Even inside
 * it, the worst a squatter gets is to write bytes into one viewer's OUTPUT; there is no input path
 * here, and `send-keys` is a separate, authenticated-by-being-local tmux call.
 *
 * `pipe-pane` is set WITHOUT `-o`. Measured: `-o` toggles, so a second call closes the pipe the
 * first opened rather than adding one, and a pane has only one pipe either way.
 */
export async function pipeTmuxPane(
  session: string,
  onData: (chunk: Uint8Array) => void,
): Promise<() => void> {
  let stopped = false;
  let connected: { end: () => void } | null = null;
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        // One writer per pane, so the listener's job is done the instant it arrives.
        connected = socket;
        server.stop();
      },
      data(_socket, chunk) {
        if (!stopped) onData(new Uint8Array(chunk));
      },
    },
  });

  const { err, code } = await tmux([
    "pipe-pane", "-t", session,
    `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${server.port}; cat >&3'`,
  ]);
  if (code !== 0) {
    stopped = true;
    server.stop(true);
    throw new TmuxUnavailable(`tmux pipe-pane exited ${code}: ${err.trim()}`);
  }

  return () => {
    if (stopped) return;
    stopped = true;
    // Tell tmux first, so its writer is not still writing into a socket being torn down.
    void tmux(["pipe-pane", "-t", session]).finally(() => {
      connected?.end();
      server.stop(true);
    });
  };
}
