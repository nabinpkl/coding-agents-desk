// Opening, feeding and closing the terminals a panel is watching.
//
// The service owns exactly what has to be owned: the live map of terminals, the one stream every
// viewer shares, and the two backends a terminal reaches its bytes through. Deciding WHAT a
// terminal is pointed at lives in `agentTerminalIdentity.ts`, reading a PTY envelope in
// `terminalStreamMessages.ts`, and the refusals in `agentTerminalErrors.ts` -- each of which the
// panel and the routes reach through this file, which stays their one import.

import { homedir } from "node:os";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
} from "@agentdesk/agent-feed-wire";
import { PtyManagerClient, type PtySessionConnection } from "./ptyClient.ts";
import {
  attachedTmuxClients,
  captureTmuxHistory,
  createTmuxSession,
  waitForPaneToSettle,
  describeTmuxPane,
  stampTmuxSessionIdentity,
  hexSend,
  pipeTmuxPane,
  releaseTmuxWindowSize,
  resizeTmuxWindow,
  restoreTmuxMouse,
  tmuxSessionExists,
} from "./tmuxSessions.ts";
import { TmuxAttachments, type TmuxSessionConnection } from "./tmuxAttachment.ts";
import type { PtyEnvelope, PtySessionSummary } from "./ptyProtocol.ts";
import {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  AgentTerminalUnavailableError,
  decodedBase64Length,
  requiredDimension,
} from "./agentTerminalErrors.ts";
import {
  identifyTerminal,
  liveTmuxSession,
  type ResolvedAgentTerminalSession,
  type TerminalIdentity,
} from "./agentTerminalIdentity.ts";
import { streamMessage } from "./terminalStreamMessages.ts";

// Re-exported because this file is the terminal's entry point: the routes want the errors, the
// composer wants the pane lookup, and neither should have to know which sibling holds them.
export {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  AgentTerminalUnavailableError,
  liveTmuxSession,
};
export type { ResolvedAgentTerminalSession };

const MAXIMUM_INPUT_BYTES = 64 * 1024;


/**
 * The two backends a terminal can be attached through, which share exactly this surface.
 *
 * A resumed CLI needs a process launched and owned, which is the PTY manager's job. A tmux session
 * was started by a human and only needs joining, which tmux can do by itself -- and on a machine
 * without the PTY daemon that is the difference between listing sessions and opening them.
 */
type TerminalConnection = PtySessionConnection | TmuxSessionConnection;

interface ActiveTerminal {
  descriptor: AgentTerminalDescriptor;
  connection: TerminalConnection;
  /** The tmux session this terminal is attached to, when that is what it is pointed at. */
  tmuxSession: string | null;
  removeEnvelope: () => void;
  removeFailure: () => void;
  ended: boolean;
}

export interface AgentTerminalPtyClient {
  listSessions(): Promise<PtySessionSummary[]>;
  openSession(options: Parameters<PtyManagerClient["openSession"]>[0]): Promise<PtySessionConnection>;
}

export class AgentTerminalService {
  private readonly terminals = new Map<string, ActiveTerminal>();
  /**
   * Watchers of every terminal, present and future.
   *
   * Per-terminal listener sets came with one HTTP stream each, which a browser cannot afford: it
   * holds about six connections per origin on HTTP/1.1 and an EventSource holds one for life. A
   * service-level set is what lets one stream serve a wall of terminals, including the ones opened
   * after it started.
   */
  private readonly observers = new Set<(envelope: AgentTerminalStreamEnvelope) => void>();

  constructor(
    socketPath: string,
    private readonly resolveSession: (
      source: "claude" | "codex",
      sessionId: string,
    ) => ResolvedAgentTerminalSession | undefined,
    private readonly userHomeDirectory = homedir(),
    private readonly pty: AgentTerminalPtyClient = new PtyManagerClient(socketPath),
    // Injected so the tests can watch what the service asks of tmux without one being installed.
    private readonly captureHistory = captureTmuxHistory,
    private readonly restoreMouse = restoreTmuxMouse,
    /**
     * Joining a tmux session without the PTY daemon. Injected whole so a test can hand over a
     * runtime with no tmux behind it, the same way `captureHistory` is.
     */
    private readonly tmux: Pick<TmuxAttachments, "open"> = new TmuxAttachments({
      describe: describeTmuxPane,
      capture: captureTmuxHistory,
      pipe: pipeTmuxPane,
      send: hexSend,
      clients: attachedTmuxClients,
      resize: resizeTmuxWindow,
      releaseSize: releaseTmuxWindowSize,
    }),
    /**
     * Resolving a session id to a tmux pane, and starting one when there is none.
     *
     * `owner` answers which tmux session a LIVE process for that session is running inside, which
     * only the process registry knows. Real by default and injected for the tests, the same way
     * every collaborator above it is: a default that answered "none" would turn a wiring mistake
     * into a second resume of a live transcript rather than into a failure.
     */
    private readonly sessionTmux: {
      owner: (source: "claude" | "codex", sessionId: string) => Promise<string | null>;
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
    } = {
      owner: liveTmuxSession,
      exists: tmuxSessionExists,
      create: createTmuxSession,
      settle: (session: string) => waitForPaneToSettle(session).then(() => {}),
    },
    /**
     * Records which Claude session a pane is running, so a rename cannot lose it.
     *
     * Its own parameter rather than a member of `sessionTmux`, because that object is injected
     * WHOLE: a test hands over its own four functions, and a fifth added to the shape is undefined
     * at run time in every one of them while the types still agree.
     */
    private readonly stampSessionIdentity = stampTmuxSessionIdentity,
  ) {
  }

  async open(
    context: AgentTerminalContext,
    dimensions: { columns: number; rows: number },
  ): Promise<AgentTerminalDescriptor> {
    const identity = await this.identify(context);
    const columns = requiredDimension(dimensions.columns, "terminal columns");
    const rows = requiredDimension(dimensions.rows, "terminal rows");

    // A tmux target never goes through the PTY daemon. Nothing has to be launched -- the session is
    // already running and owned by whoever started it -- and asking a daemon that may not be
    // installed to attach it is how a machine with tmux and no daemon ends up listing sessions it
    // cannot open.
    if (identity.tmuxSession) {
      const created = identity.createTmux !== null &&
        !(await this.tmuxExists(identity.tmuxSession));
      if (created) {
        await this.startTmux(identity.createTmux!, identity.tmuxSession, { columns, rows });
        // Only for a pane THIS call just created. An existing pane has already collapsed its
        // startup into scrollback, which is what makes joining one feel instant; a newborn one
        // would otherwise pipe every byte of that startup live and make the viewer emulate it.
        await this.sessionTmux.settle(identity.tmuxSession);
      }
      // Stamped on every open, not only on the one that created the pane. That is what adopts a
      // pane started before this existed, and what re-stamps one whose option was lost -- and it
      // is idempotent, so the ordinary case costs one tmux call that changes nothing.
      //
      // Best effort, deliberately: the stamp makes a pane findable AFTER a rename, and a terminal
      // that opens is worth more than one refused because its label could not be written.
      if (identity.stampSession) {
        await this.stampSessionIdentity(identity.tmuxSession, identity.stampSession)
          .catch(() => {});
      }
      return this.attachTmux(identity, identity.tmuxSession, { columns, rows });
    }

    let sessions: PtySessionSummary[];
    try {
      sessions = await this.pty.listSessions();
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
      connection = await this.pty.openSession({
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

    return this.register(identity, connection);
  }

  private async tmuxExists(session: string): Promise<boolean> {
    try {
      return await this.sessionTmux.exists(session);
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
  private async startTmux(
    create: { cwd: string; command: readonly string[] },
    session: string,
    dimensions: { columns: number; rows: number },
  ): Promise<void> {
    try {
      await this.sessionTmux.create({ session, ...create, ...dimensions });
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
  private async attachTmux(
    identity: TerminalIdentity,
    session: string,
    dimensions: { columns: number; rows: number },
  ): Promise<AgentTerminalDescriptor> {
    let connection: TmuxSessionConnection;
    try {
      connection = await this.tmux.open(session, dimensions);
    } catch (error) {
      throw new AgentTerminalUnavailableError(`tmux could not attach ${session}`, { cause: error });
    }
    return this.register(identity, connection);
  }

  /**
   * The half both backends share: an id, a descriptor, the envelope and failure wiring.
   *
   * Factored out when tmux became a second backend, because everything after "there is a
   * connection" is identical and a divergence here is the kind that shows up as one backend's
   * terminals never reporting an exit.
   */
  private register(
    identity: TerminalIdentity,
    connection: TerminalConnection,
  ): AgentTerminalDescriptor {
    const terminalId = crypto.randomUUID();
    const descriptor: AgentTerminalDescriptor = {
      terminalId,
      ptySessionName: identity.ptySessionName,
      pid: connection.attachment.pid,
      columns: connection.attachment.columns,
      rows: connection.attachment.rows,
    };
    const active: ActiveTerminal = {
      descriptor,
      connection,
      tmuxSession: identity.tmuxSession,
      removeEnvelope: () => {},
      removeFailure: () => {},
      ended: false,
    };
    active.removeEnvelope = connection.onEnvelope((envelope) => this.receive(active, envelope));
    active.removeFailure = connection.onFailure((error) => {
      if (!active.ended) this.publish(active, { type: "error", message: error.message });
      this.finish(active);
    });
    this.terminals.set(terminalId, active);
    // After the attach, not before: the option is this session's, and touching a session that
    // turned out not to open would be a change nobody asked for. This clears the `mouse off` an
    // older build wrote here, so the session goes back to the owner's own setting; failing costs
    // that repair, not the terminal, so it is reported rather than thrown.
    if (identity.tmuxSession) {
      this.restoreMouse(identity.tmuxSession).catch((error: unknown) => {
        console.error("tmux mouse restore failed", error);
      });
    }
    return descriptor;
  }

  /**
   * The pane's own history, for a viewer that has none.
   *
   * A `tmux attach` draws one screen, so everything before the attach exists only in tmux. Nothing
   * to hand over for a resumed CLI: that terminal's history is the PTY manager's, and it replays.
   */
  async history(terminalId: string, lines: number): Promise<string> {
    const active = this.require(terminalId);
    if (!active.tmuxSession) return "";
    return this.captureHistory(active.tmuxSession, lines);
  }

  /**
   * Joins a tmux pane purely to be TOLD when it writes, without opening a terminal.
   *
   * Exists because a pane has exactly one pipe, and this service owns it. Anything else that
   * wanted to know when a pane changed -- the composer mirror is the first -- would have to set a
   * second `pipe-pane`, which does not add one: it silently replaces the first, and neither side
   * can tell. So the signal is handed out from here, through the same fan-out every viewer uses,
   * and a watcher costs nothing beyond a set the terminal path was going to make anyway.
   *
   * It never creates a session. The caller resolves which pane it means and passes the name, so
   * watching a session that is not running is a lookup that answers nothing rather than a resume.
   *
   * `onOutput` carries no bytes on purpose. What it says is "this pane is not what it was", which
   * is all a reader of the SCREEN needs; handing over the stream would invite a second, partial
   * terminal emulator to grow next to the real one.
   */
  async watchPane(session: string, onOutput: () => void): Promise<() => void> {
    // Dimensions are ignored by the tmux path -- the pane is authoritative and a viewer adopts
    // what it finds -- so these name what this watcher would like and get nothing said back.
    const connection = await this.tmux.open(session, { columns: 80, rows: 24 });
    const removeEnvelope = connection.onEnvelope((envelope) => {
      if (envelope.output) onOutput();
    });
    return () => {
      removeEnvelope();
      connection.detach();
    };
  }

  observe(listener: (envelope: AgentTerminalStreamEnvelope) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  /**
   * Asks the PTY to replay the screen, which is how a viewer paints what was already there.
   *
   * Separate from `observe` because the two are no longer one act: the stream is shared and
   * long-lived, while a viewer arrives per terminal and needs the replay addressed to it. A viewer
   * that requested it during `observe` would race the panel's own dispatcher and paint nothing.
   */
  requestCheckpoint(terminalId: string): void {
    this.require(terminalId).connection.requestCheckpoint("0");
  }

  sendInput(terminalId: string, data: string, encoding: "utf8" | "base64"): void {
    const byteLength = encoding === "utf8"
      ? Buffer.byteLength(data, "utf8")
      : decodedBase64Length(data);
    if (byteLength > MAXIMUM_INPUT_BYTES) {
      throw new AgentTerminalInvalidError("terminal input exceeds 64 KiB");
    }
    const connection = this.require(terminalId).connection;
    if (encoding === "utf8") connection.sendInput(data);
    else connection.sendBinaryInput(data);
  }

  updateViewport(terminalId: string, viewport: AgentTerminalViewport): void {
    const columns = requiredDimension(viewport.columns, "viewport columns");
    const rows = requiredDimension(viewport.rows, "viewport rows");
    if (!/^\d+$/.test(viewport.sequence)) {
      throw new AgentTerminalInvalidError("viewport sequence must be an unsigned integer string");
    }
    this.require(terminalId).connection.updateViewerState({ ...viewport, columns, rows });
  }

  /**
   * A viewer is leaving. `kill` ends the PTY session with it; `detach` leaves it running.
   *
   * A kill is honoured only when this is the last viewer of that PTY session. Viewers of one
   * target share it -- two tiles of one tmux session, or a phone and a Mac on the same one, are
   * separate connections to a single `tmux attach` process -- so an unconditional kill would end
   * everyone else's terminal because one tab closed. Measured that way: closing one panel tab took
   * the other's tile down with it. The viewer that asked still leaves; it just leaves by detaching.
   */
  close(terminalId: string, mode: "detach" | "kill"): void {
    const active = this.require(terminalId);
    if (mode === "kill" && this.isLastViewer(active)) {
      active.connection.kill();
      return;
    }
    active.ended = true;
    this.publish(active, { type: "detached" });
    active.connection.detach();
    this.finish(active);
  }

  private isLastViewer(active: ActiveTerminal): boolean {
    for (const other of this.terminals.values()) {
      if (other === active || other.ended) continue;
      if (other.descriptor.ptySessionName === active.descriptor.ptySessionName) return false;
    }
    return true;
  }

  stop(): void {
    for (const active of this.terminals.values()) {
      active.ended = true;
      try {
        active.connection.detach();
      } catch (error) {
        console.error("agent terminal detach during shutdown failed", error);
      }
      this.finish(active);
    }
  }

  /**
   * Hands the resolution its three collaborators, which is all this class owes it.
   *
   * `sessionTmux.owner` is wrapped rather than passed, because that object is injected whole and a
   * test's copy is a plain record: a bare reference would lose whatever `this` it was written to
   * expect.
   */
  private identify(context: AgentTerminalContext): Promise<TerminalIdentity> {
    return identifyTerminal({
      userHomeDirectory: this.userHomeDirectory,
      resolveSession: this.resolveSession,
      tmuxOwner: (source, sessionId) => this.sessionTmux.owner(source, sessionId),
    }, context);
  }

  private receive(active: ActiveTerminal, envelope: PtyEnvelope): void {
    const message = streamMessage(envelope);
    if (!message) return;
    this.publish(active, message);
    if (message.type === "exited" || message.type === "detached" || message.type === "error") {
      active.ended = true;
      this.finish(active);
    }
  }

  private publish(active: ActiveTerminal, message: AgentTerminalStreamMessage): void {
    const envelope: AgentTerminalStreamEnvelope = {
      terminalId: active.descriptor.terminalId,
      message,
    };
    for (const observer of this.observers) observer(envelope);
  }

  private finish(active: ActiveTerminal): void {
    if (!this.terminals.delete(active.descriptor.terminalId)) return;
    active.removeEnvelope();
    active.removeFailure();
    active.connection.closeTransport();
  }

  private require(terminalId: string): ActiveTerminal {
    const active = this.terminals.get(terminalId);
    if (!active) throw new AgentTerminalNotFoundError("terminal connection was not found");
    return active;
  }
}



function isRunning(session: PtySessionSummary): boolean {
  return session.state === "SESSION_STATE_RUNNING" || session.state === 1;
}

