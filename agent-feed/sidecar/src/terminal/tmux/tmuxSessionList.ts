// Which tmux sessions exist, which one is a given agent session, and how a new one is
// started.
//
// Identity is a session option rather than the name, so a session can be renamed to
// something a person types at `tmux attach` without the panel losing it.

import type { TmuxPaneSummary, TmuxSessionSummary, TmuxWindowSummary } from "@agentdesk/agent-feed-wire";
import { noServerRunning, noSuchSession, TmuxUnavailable, tmux } from "@/terminal/tmux/tmuxCommand";

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
      windowList: [],
    });
  }
  return sessions;
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
  // No server, and a server without that session, are both ordinary answers to the question.
  if (noServerRunning(err + out) || noSuchSession(err + out)) return false;
  throw new TmuxUnavailable(`tmux has-session exited ${code}: ${err.trim() || out.trim()}`);
}

/**
 * The tmux option carrying which Claude session a tmux session is running.
 *
 * A user option (`@`) rather than the session NAME, which is what this used to be. The name was
 * derived from the session uuid so two viewers could agree on one pane without coordinating --
 * real work, but it made the name a lookup key, and a key cannot be renamed. Measured: renaming a
 * session left the sidecar addressing a name tmux no longer had, and the panel minted a second
 * session beside it.
 *
 * An option separates the two jobs. It rides through every rename (measured), so identity is
 * stable while the name is free to be something a person can type at `tmux attach -t`.
 */
const SESSION_IDENTITY_OPTION = "@agentdesk-session";

/**
 * Stamps which Claude session this tmux session is running.
 *
 * No `=` prefix on the target, unlike `has-session` below: `set-option` does not accept one and
 * answers `no such session: =name` for a session that is right there. Measured 2026-09-08, and it
 * fails in the worst way -- exit non-zero with the option silently unset, so a later lookup finds
 * nothing and concludes the session is gone.
 */
export function setSessionIdentityArgs(session: string, sessionId: string): string[] {
  return ["set-option", "-t", session, SESSION_IDENTITY_OPTION, sessionId];
}

export async function stampTmuxSessionIdentity(
  session: string,
  sessionId: string,
): Promise<void> {
  const { err, code } = await tmux(setSessionIdentityArgs(session, sessionId));
  if (code !== 0) throw new TmuxUnavailable(`tmux set-option exited ${code}: ${err.trim()}`);
}

/** One line per session: the name, and the Claude session it is running if it says. */
const IDENTITY_FORMAT = `#{session_name}|#{${SESSION_IDENTITY_OPTION}}`;

export function parseTmuxSessionIdentities(stdout: string): Map<string, string> {
  const bySessionId = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("|");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const sessionId = line.slice(separator + 1).trim();
    // Empty is ordinary and by far the common case: every session tmux holds that this sidecar
    // did not start prints an empty option rather than failing the query.
    if (!name || !sessionId) continue;
    // First wins. Two panes claiming one session is a bug elsewhere, and picking the later one
    // would move a viewer off the pane it was already reading.
    if (!bySessionId.has(sessionId)) bySessionId.set(sessionId, name);
  }
  return bySessionId;
}

/** Which tmux session is running this Claude session, by the stamp rather than by its name. */
export async function findTmuxSessionByIdentity(sessionId: string): Promise<string | null> {
  const { out, err, code } = await tmux(["list-sessions", "-F", IDENTITY_FORMAT]);
  if (code !== 0) {
    if (noServerRunning(err)) return null;
    throw new TmuxUnavailable(`tmux list-sessions exited ${code}: ${err.trim() || out.trim()}`);
  }
  return parseTmuxSessionIdentities(out).get(sessionId) ?? null;
}

/**
 * Renames a tmux session, which is now only a change of label.
 *
 * Safe precisely because nothing resolves by name any more: the stamp above is what a viewer finds
 * a pane by, and the pane id in every open attachment is untouched. `=` for exactness, so a
 * prefix hit cannot rename somebody else's session.
 */
export function renameSessionArgs(session: string, name: string): string[] {
  return ["rename-session", "-t", `=${session}`, name];
}

export async function renameTmuxSessionTo(session: string, name: string): Promise<void> {
  const { err, out, code } = await tmux(renameSessionArgs(session, name));
  if (code !== 0) {
    throw new TmuxUnavailable(`tmux rename-session exited ${code}: ${err.trim() || out.trim()}`);
  }
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
  //
  // Every argument quoted, not just the script. This is an argv being flattened into a shell
  // script, so an argument carrying a space or a metacharacter stops being one argument the moment
  // it is joined. It went unnoticed while every argument was a bare token; the first title passed
  // to `-n` broke it, because zsh reads the `(fork 1)` in `Session (fork 1)` as a glob qualifier
  // and answers "invalid mode specification" instead of running anything.
  const script = `${command.map(shellQuote).join(" ")}; exec ${LOGIN_SHELL} -l`;
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

/**
 * Single-quoted for `sh -c`, with the one escape single quotes have.
 *
 * A single-quoted string cannot contain a single quote at all, so each one leaves the quoting,
 * contributes an escaped `'`, and re-enters it: `it's` becomes `'it'\''s'`. Writing that in a
 * JavaScript string needs the backslash escaped -- `"'\\''"` -- and without it this produced
 * `'it'''s'`, which leaves the shell inside an unterminated quote.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Empty when the server is not running, which is not a failure: nobody has started a session. */
export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const { out, err, code } = await tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (code !== 0) {
    // An empty machine is how tmux reports no server, and it exits non-zero saying so.
    if (noServerRunning(err)) return [];
    throw new TmuxUnavailable(`tmux list-sessions exited ${code}: ${err.trim() || out.trim()}`);
  }
  const sessions = parseTmuxSessions(out);
  if (sessions.length === 0) return sessions;
  // Windows and panes ride two more queries because one session row is no longer the whole
  // story: a session with four windows shows one child and hides three. Both list across ALL
  // sessions (`-a`) rather than one call per session, so a wall of sessions still costs three
  // round trips, not three per session.
  foldWindows(sessions, await listTmuxWindows());
  return sessions;
}

/**
 * Every window on the server, grouped by session, in index order.
 *
 * A server that died between the sessions query and this one reads as no windows rather than
 * as a failed tab: the sessions just listed are a millisecond stale either way, and the next
 * refresh retries. Anything else throws, the same as the sessions query.
 */
async function listTmuxWindows(): Promise<Map<string, TmuxWindowSummary[]>> {
  const { out, err, code } = await tmux(["list-windows", "-a", "-F", WINDOWS_FORMAT]);
  if (code !== 0) {
    if (noServerRunning(err)) return new Map();
    throw new TmuxUnavailable(`tmux list-windows exited ${code}: ${err.trim() || out.trim()}`);
  }
  const bySession = parseTmuxWindows(out);
  const panes = await listTmuxPanes();
  for (const [session, windows] of bySession) {
    for (const window of windows) {
      window.panes = panes.get(`${session} ${window.index}`) ?? [];
    }
  }
  return bySession;
}

async function listTmuxPanes(): Promise<Map<string, TmuxPaneSummary[]>> {
  const { out, err, code } = await tmux(["list-panes", "-a", "-F", PANES_FORMAT]);
  if (code !== 0) {
    if (noServerRunning(err)) return new Map();
    throw new TmuxUnavailable(`tmux list-panes exited ${code}: ${err.trim() || out.trim()}`);
  }
  return parseTmuxPanes(out);
}

function foldWindows(sessions: TmuxSessionSummary[], bySession: Map<string, TmuxWindowSummary[]>): void {
  for (const session of sessions) {
    session.windowList = bySession.get(session.name) ?? [];
  }
}

/**
 * Field separator for the windows and panes queries.
 *
 * `|` the way the sessions query uses it, because control bytes are NOT an option: the
 * sidecar runs locale-stripped and tmux in the C locale sanitizes control bytes in `-F`
 * output to `_` (measured: a tab separator arrived underscored). A window NAME and a pane
 * PATH can both hold a pipe, so the free-form fields ride LAST and join the remainder --
 * fully robust for windows, and for panes everything past the command, which pins the one
 * residual: a `|` inside a pane's command garbles that single pane's row rather than the
 * listing. Splitting is positional throughout: the leading fields are all controlled.
 */
const SEP = "|";

/** Session, index and active flag first; the free-form name last, never split. */
const WINDOWS_FORMAT = `#{session_name}${SEP}#{window_index}${SEP}#{window_active}${SEP}#{window_name}`;

/** Session, window, pane, active flag, command first; the free-form path last, never split. */
const PANES_FORMAT = `#{session_name}${SEP}#{window_index}${SEP}#{pane_index}${SEP}#{pane_active}${SEP}#{pane_current_command}${SEP}#{pane_current_path}`;

function splitFields(line: string, count: number): string[] | null {
  const fields = line.split(SEP);
  if (fields.length < count) return null;
  const head = fields.slice(0, count - 1);
  head.push(fields.slice(count - 1).join(SEP));
  return head;
}

export function parseTmuxWindows(stdout: string): Map<string, TmuxWindowSummary[]> {
  const bySession = new Map<string, TmuxWindowSummary[]>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = splitFields(line, 4);
    // Same contract as the sessions parser: an unreadable line is format drift, said loudly.
    if (!fields) throw new TmuxUnavailable(`tmux list-windows returned an unreadable line: ${line}`);
    const [session, index, active, name] = fields as [string, string, string, string];
    if (!session || !/^\d+$/.test(index) || (active !== "0" && active !== "1") || !name) {
      throw new TmuxUnavailable(`tmux list-windows returned an unreadable line: ${line}`);
    }
    const list = bySession.get(session) ?? [];
    list.push({
      index: Number(index),
      name,
      active: active === "1",
      panes: [],
    });
    bySession.set(session, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.index - b.index);
  }
  return bySession;
}

export function parseTmuxPanes(stdout: string): Map<string, TmuxPaneSummary[]> {
  const byWindow = new Map<string, TmuxPaneSummary[]>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = splitFields(line, 6);
    if (!fields) throw new TmuxUnavailable(`tmux list-panes returned an unreadable line: ${line}`);
    const [session, window, pane, active, command, path] = fields as [string, string, string, string, string, string];
    if (!session || !/^\d+$/.test(window) || !/^\d+$/.test(pane) || (active !== "0" && active !== "1")) {
      throw new TmuxUnavailable(`tmux list-panes returned an unreadable line: ${line}`);
    }
    const key = `${session} ${window}`;
    const list = byWindow.get(key) ?? [];
    list.push({ index: Number(pane), active: active === "1", command, path });
    byWindow.set(key, list);
  }
  for (const list of byWindow.values()) {
    list.sort((a, b) => a.index - b.index);
  }
  return byWindow;
}

export function killSessionArgs(session: string): string[] {
  // `=` for the same reason `hasSessionArgs` uses it, and it matters more here: tmux resolves a
  // bare `-t name` by exact match, then PREFIX, so killing `agentdesk-x` without it would end
  // `agentdesk-xy` when the first no longer exists.
  return ["kill-session", "-t", `=${session}`];
}

/**
 * Ends a session and everything running in it.
 *
 * The one destructive tmux verb in this repository, and `tmuxAttachment.ts` says above `detach()`
 * never to send it "whatever the caller called it". That rule is about a VIEWER: a browser tab
 * closing must not end work it was only ever watching, because the session belongs to whoever
 * started it. This is the opposite actor -- the owner asking on purpose, through an endpoint whose
 * entire subject is ending a session -- so the rule is satisfied rather than broken. Do not merge
 * this path with the viewer's, and do not delete it as a violation of a rule it is the exception
 * to; `retireSessions` in `botSessionRemoval.ts` is its only caller.
 *
 * A session that is already gone is not an error. Retiring something that has already stopped is
 * the ordinary case rather than the surprising one.
 */
export async function killTmuxSession(session: string): Promise<void> {
  const { out, err, code } = await tmux(killSessionArgs(session));
  if (code === 0) return;
  if (noServerRunning(err + out) || noSuchSession(err + out)) return;
  throw new TmuxUnavailable(`tmux kill-session exited ${code}: ${err.trim() || out.trim()}`);
}
