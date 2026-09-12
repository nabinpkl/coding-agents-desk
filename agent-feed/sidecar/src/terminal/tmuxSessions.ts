// The multiplexer's own session list, which is what the terminal grid attaches to.
//
// Why tmux and not the PTY manager's own sessions: the manager can re-attach a process IT
// started, and the sessions worth watching were started by hand from a real terminal. tmux is
// what makes a second viewer of an already-running process legal, so it is the thing to ask.
//
// The parts: `tmuxCommand.ts` runs tmux at all, `tmuxCapture.ts` reads what a pane shows,
// `tmuxSessionList.ts` says which sessions exist and starts new ones, and this drives a
// pane that already exists.

import { TmuxUnavailable, tmux } from "@/terminal/tmuxCommand";

// Re-exported because this is the address nine callers already have, and the four parts
// are one conversation with one tmux server.
export { TmuxUnavailable } from "@/terminal/tmuxCommand";
export {
  captureHistoryArgs,
  captureScreenArgs,
  capturePaneViewArgs,
  captureTmuxHistory,
  captureTmuxPaneView,
  historyForTerminal,
  paneActivity,
  paneActivityArgs,
  paneGeometryArgs,
  terminalHistoryPayload,
  waitForPaneToSettle,
  type TmuxPaneView,
} from "@/terminal/tmuxCapture";
export {
  createTmuxSession,
  findTmuxSessionByIdentity,
  hasSessionArgs,
  listTmuxSessions,
  newSessionArgs,
  parseTmuxSessionIdentities,
  parseTmuxSessions,
  renameSessionArgs,
  renameTmuxSessionTo,
  setSessionIdentityArgs,
  stampTmuxSessionIdentity,
  tmuxSessionExists,
  type NewTmuxSession,
} from "@/terminal/tmuxSessionList";

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

export function attachedClientArgs(session: string): string[] {
  return ["list-clients", "-t", session, "-F", "#{client_name}"];
}

/**
 * How many REAL tmux clients are watching this session.
 *
 * The panel is never one of them and cannot be counted by mistake: it drives tmux through
 * `capture-pane`, `pipe-pane` and `send-keys`, so tmux has never heard of it. Measured across 20
 * live sessions here, every one of them answered zero.
 *
 * This is the whole safety condition for resizing. tmux has ONE window size for everyone, so a
 * resize while a human is attached reflows the session inside their own terminal -- measured in
 * ADR terms by the bug this replaces, where a tile opening at 80x24 redrew a live Claude Code TUI
 * with its composer off the bottom of its frame.
 *
 * So an unreadable answer THROWS rather than returning zero. A missing session exits 1, and
 * reading that as "nobody is attached" would resize on exactly the evidence that says we cannot
 * tell. A live session with no clients exits 0 with no output, which is the answer we want.
 */
export async function attachedTmuxClients(session: string): Promise<number> {
  const { out, err, code } = await tmux(attachedClientArgs(session));
  if (code !== 0) {
    throw new TmuxUnavailable(`tmux list-clients exited ${code}: ${err.trim() || out.trim()}`);
  }
  return out.split("\n").filter((line) => line.trim() !== "").length;
}

export function resizeWindowArgs(session: string, columns: number, rows: number): string[] {
  return ["resize-window", "-t", session, "-x", String(columns), "-y", String(rows)];
}

/**
 * Makes the session's window this shape. It is EVERY client's shape, which is why every caller
 * checks `attachedTmuxClients` first.
 */
export async function resizeTmuxWindow(
  session: string,
  columns: number,
  rows: number,
): Promise<void> {
  const { err, code } = await tmux(resizeWindowArgs(session, columns, rows));
  if (code !== 0) throw new TmuxUnavailable(`tmux resize-window exited ${code}: ${err.trim()}`);
}

export function releaseWindowSizeArgs(session: string): string[] {
  return ["set-option", "-w", "-t", session, "-u", "window-size"];
}

/**
 * Hands the size back to tmux's own client negotiation, for a window this process resized.
 *
 * `resize-window -x -y` pins the window to `window-size manual` as a side effect -- measured, and
 * it is what left four sessions stuck that way the last time this repo resized panes. A pinned
 * window no longer follows a human who attaches later, so the pin has to be lifted when the last
 * panel viewer leaves. Unsetting restores the inherited value (`latest` here) and leaves the size
 * itself alone, which is the right pair: the shape the reader left it in, free to move again.
 */
export async function releaseTmuxWindowSize(session: string): Promise<void> {
  const { err, code } = await tmux(releaseWindowSizeArgs(session));
  if (code !== 0) throw new TmuxUnavailable(`tmux set-option exited ${code}: ${err.trim()}`);
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
): Promise<() => Promise<void>> {
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

  // Awaitable, because a pane has ONE pipe and turning it off is a command like any other: a
  // viewer that leaves and one that arrives a moment later issue an off and an on for the same
  // pane, and fire-and-forget lets them land in that order or the other one. Measured on a live
  // pane during a burst of opening and closing: `pane_pipe` read 0 with three viewers attached,
  // and 1 with none. A terminal with no pipe is not broken-looking -- it shows the screen it
  // imported and then never changes again.
  return async () => {
    if (stopped) return;
    stopped = true;
    // Tell tmux first, so its writer is not still writing into a socket being torn down.
    try {
      await tmux(["pipe-pane", "-t", session]);
    } finally {
      connected?.end();
      server.stop(true);
    }
  };
}
