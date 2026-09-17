// Reaching a live connection for a terminal, through whichever backend its target names.
//
// Two backends and one question: is there something to join, and if not, may this call start
// it? A resumed CLI needs a process launched and owned, which is the PTY manager's job; a tmux
// pane was started by a human and only needs joining, which tmux does by itself. Everything
// after "there is a connection" is identical, and stays in the service.
//
// Every way either backend can fail is reported as unavailable rather than not-found, because
// from the panel's side the two are the same shape -- a tile that cannot open -- and the
// message is what tells them apart.

import { PtyManagerClient, type PtySessionConnection } from "@/terminal/pty/ptyClient";
import type { TmuxAttachments, TmuxSessionConnection } from "@/terminal/tmux/tmuxAttachment";
import type { PtySessionSummary } from "@/terminal/pty/ptyProtocol";
import { AgentTerminalConflictError, AgentTerminalUnavailableError } from "@/terminal/agentTerminalErrors";
import type { TerminalIdentity } from "@/terminal/agentTerminalIdentity";

export interface AgentTerminalPtyClient {
  listSessions(): Promise<PtySessionSummary[]>;
  openSession(options: Parameters<PtyManagerClient["openSession"]>[0]): Promise<PtySessionConnection>;
}

/**
 * Everything joining a tmux pane needs, taken as one record rather than off the service.
 *
 * `attachments` and `sessionTmux` are passed as objects, not as their methods: both are injected
 * whole, so a test's copy is a plain record and a bare method reference would lose the `this` it
 * was written to expect.
 */
export interface TmuxTerminalBackend {
  attachments: Pick<TmuxAttachments, "open">;
  sessionTmux: {
    exists: (session: string) => Promise<boolean>;
    create: (options: {
      session: string;
      cwd: string;
      command: readonly string[];
      columns: number;
      rows: number;
    }) => Promise<void>;
    /** Waits for a just-created pane to stop writing, so its startup lands in the capture. */
    settle: (session: string) => Promise<void>;
  };
  stampSessionIdentity: (session: string, sessionId: string) => Promise<unknown>;
  /**
   * Stamps a pane and renames it after its session's title, answering the name it ended up with.
   *
   * A member of this object rather than reached for directly, for the same reason the stamp is one:
   * the backend is injected WHOLE by tests, so a function imported straight into the body here
   * would drive real tmux from a test that handed over its own.
   */
  relabelSession: (pane: string, sessionId: string, title: string) => Promise<string>;
}

/**
 * The pane this identity names, joined -- started first when this is the call that must.
 *
 * Nothing has to be launched for a target somebody else is already running, and asking a daemon
 * that may not be installed to attach it is how a machine with tmux and no daemon ends up listing
 * sessions it cannot open.
 */
export async function connectTmuxTerminal(
  backend: TmuxTerminalBackend,
  identity: TerminalIdentity,
  session: string,
  dimensions: { columns: number; rows: number },
): Promise<TmuxSessionConnection> {
  const created = identity.createTmux !== null &&
    !(await tmuxExists(backend, session));
  if (created) {
    await startTmux(backend, identity.createTmux!, session, dimensions);
    // Only for a pane THIS call just created. An existing pane has already collapsed its
    // startup into scrollback, which is what makes joining one feel instant; a newborn one
    // would otherwise pipe every byte of that startup live and make the viewer emulate it.
    await backend.sessionTmux.settle(session);
  }
  // Stamped on every open, not only on the one that created the pane. That is what adopts a
  // pane started before this existed, and what re-stamps one whose option was lost -- and it
  // is idempotent, so the ordinary case costs one tmux call that changes nothing.
  //
  // Best effort, deliberately: the stamp makes a pane findable AFTER a rename, and a terminal
  // that opens is worth more than one refused because its label could not be written.
  let target = session;
  if (identity.stampSession) {
    if (created && identity.nameFromTitle) {
      // A pane this call brought into existence is this call's to name, and it is named the way a
      // session started with no terminal watching is -- otherwise reopening a session whose pane
      // is gone would be the one remaining way to put a uuid on the session list.
      //
      // The attach below uses the ANSWER rather than the name above it: tmux addresses a session
      // by name, so attaching under the old one would miss a pane that had just been renamed.
      target = await backend.relabelSession(session, identity.stampSession, identity.nameFromTitle);
    } else {
      await backend.stampSessionIdentity(session, identity.stampSession)
        .catch(() => {});
    }
  }
  return attachTmux(backend, target, dimensions);
}

async function tmuxExists(backend: TmuxTerminalBackend, session: string): Promise<boolean> {
  try {
    return await backend.sessionTmux.exists(session);
  } catch (error) {
    throw new AgentTerminalUnavailableError("tmux could not be asked about its sessions", {
      cause: error,
    });
  }
}

/**
 * Starts the session's own tmux, resuming it, because nothing is running it yet.
 *
 * At the viewer's geometry: this session has no other client to take a size from, and a detached
 * `new-session` would otherwise sit at 80x24 for its whole life while the viewer reads it.
 */
async function startTmux(
  backend: TmuxTerminalBackend,
  create: { cwd: string; command: readonly string[] },
  session: string,
  dimensions: { columns: number; rows: number },
): Promise<void> {
  try {
    await backend.sessionTmux.create({ session, ...create, ...dimensions });
  } catch (error) {
    throw new AgentTerminalUnavailableError(`tmux could not start ${session}`, { cause: error });
  }
}

/**
 * Joins a tmux session with tmux's own primitives, no daemon involved.
 *
 * The failure is reported as unavailable rather than not-found because from the panel's side the
 * two are the same shape -- a tile that cannot open -- and the message is what tells them apart.
 */
async function attachTmux(
  backend: TmuxTerminalBackend,
  session: string,
  dimensions: { columns: number; rows: number },
): Promise<TmuxSessionConnection> {
  let connection: TmuxSessionConnection;
  try {
    connection = await backend.attachments.open(session, dimensions);
  } catch (error) {
    throw new AgentTerminalUnavailableError(`tmux could not attach ${session}`, { cause: error });
  }
  return connection;
}

/**
 * The identity's PTY session, joined when it is already running and started when it is not.
 *
 * The session name is deterministic per target, so a second viewer joins the running one instead
 * of starting a second. A name that exists but has exited is a conflict rather than a fresh start:
 * the terminal a reader asked for is gone, and quietly opening a different one in its place would
 * hide that.
 */
export async function connectPtyTerminal(
  pty: AgentTerminalPtyClient,
  identity: TerminalIdentity,
  { columns, rows }: { columns: number; rows: number },
): Promise<PtySessionConnection> {
  let sessions: PtySessionSummary[];
  try {
    sessions = await pty.listSessions();
  } catch (error) {
    throw new AgentTerminalUnavailableError("PTY manager is unavailable", { cause: error });
  }
  const existing = sessions.find((session) => session.name === identity.ptySessionName);
  if (existing && !isRunning(existing)) {
    throw new AgentTerminalConflictError("the deterministic terminal session has already exited");
  }
  if (!existing && identity.refuseNew) {
    throw new AgentTerminalConflictError(identity.refuseNew);
  }

  let connection: PtySessionConnection;
  try {
    connection = await pty.openSession({
      sessionName: identity.ptySessionName,
      launch: {
        cwd: identity.cwd,
        executable: "/bin/zsh",
        // Through a login shell, so a command is found on the user's own PATH rather than the
        // sidecar's, which is deliberately stripped of it. With no command it IS the shell: the
        // pty gives it a tty, which is what makes `-l` interactive.
        arguments: identity.command.length === 0
          ? ["-l"]
          : ["-l", "-c", 'exec "$0" "$@"', ...identity.command],
      },
      columns,
      rows,
      createIfMissing: existing === undefined,
      clientTitle: "Agent Feed",
    });
  } catch (error) {
    throw new AgentTerminalUnavailableError("PTY manager refused the terminal connection", {
      cause: error,
    });
  }
  if (connection.attachment.sessionName !== identity.ptySessionName) {
    connection.detach();
    throw new AgentTerminalConflictError("PTY manager returned the wrong terminal session");
  }
  return connection;
}

function isRunning(session: PtySessionSummary): boolean {
  return session.state === "SESSION_STATE_RUNNING" || session.state === 1;
}
