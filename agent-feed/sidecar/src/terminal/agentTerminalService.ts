// Opening, feeding and closing the terminals a panel is watching.
//
// The service owns exactly what has to be owned: the live map of terminals, the one stream every
// viewer shares, and the two backends a terminal reaches its bytes through. Deciding WHAT a
// terminal is pointed at lives in `agentTerminalIdentity.ts`, reading a PTY envelope in
// `terminalStreamMessages.ts`, and the refusals in `agentTerminalErrors.ts` -- each of which the
// panel and the routes reach through this file, which stays their one import.

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
  SessionTmuxTerminalContext,
  StaleClaudeSessions,
  StaleSessionRestartResult,
} from "@agentdesk/agent-feed-wire";
import { PtyManagerClient, type PtySessionConnection } from "@/terminal/pty/ptyClient";
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
  reviveExitedPane,
  tmuxSessionExists,
} from "@/terminal/tmux/tmuxSessions";
import { TmuxAttachments, type TmuxSessionConnection } from "@/terminal/tmux/tmuxAttachment";
import { adoptTitleName } from "@/terminal/tmux/tmuxRelabel";
import type { PtyEnvelope, PtySessionSummary } from "@/terminal/pty/ptyProtocol";
import {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  AgentTerminalUnavailableError,
  decodedBase64Length,
  requiredDimension,
  requiredSessionUuid,
} from "@/terminal/agentTerminalErrors";
import { restartClaudeSession } from "@/terminal/session-panes/claudeSessionLaunch";
import {
  listStaleSessions,
  liveStaleSessionSources,
  restartStaleSessions,
  type StaleSessionSources,
} from "@/terminal/session-panes/staleClaudeSessions";
import {
  identifyTerminal,
  tmuxTargetSession,
  type ResolvedAgentTerminalSession,
  type TerminalIdentity,
} from "@/terminal/agentTerminalIdentity";
import { claudeSessionRunning, liveTmuxSession } from "@/terminal/session-panes/tmuxSessionOwner";
import { streamMessage } from "@/terminal/pty/terminalStreamMessages";
import {
  connectPtyTerminal,
  connectTmuxTerminal,
  type AgentTerminalPtyClient,
} from "@/terminal/agentTerminalBackends";

// Re-exported because this file is the terminal's entry point: the routes want the errors, the
// composer wants the pane lookup, and neither should have to know which sibling holds them.
export {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  AgentTerminalUnavailableError,
  liveTmuxSession,
};
export type { AgentTerminalPtyClient, ResolvedAgentTerminalSession };

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
      source: "claude" | "codex" | "opencode",
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
      owner: (source: "claude" | "codex" | "opencode", sessionId: string) => Promise<string | null>;
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
    /**
     * Names a pane this service just created after the session inside it. Its own parameter for the
     * same reason the stamp above is: `sessionTmux` is injected whole and a fifth member added to
     * that shape is undefined at run time in every test that hands over its own four.
     */
    private readonly relabelSession = adoptTitleName,
    /** Replaces the process in a session's own pane; injected for the same reason the two above are. */
    private readonly restartPane = restartClaudeSession,
    /** Runs a joined pane's exited command again; injected for the same reason. */
    private readonly revivePane = reviveExitedPane,
    /** Whether a live Claude process holds a session, which forbids resuming it again in its pane. */
    private readonly claudeRunning = claudeSessionRunning,
    /** What says which sessions are behind the launch; injected for the same reason. */
    private readonly staleSources: StaleSessionSources = liveStaleSessionSources,
  ) {
  }

  /** Every Claude session in a pane this sidecar launched that is behind its flags or CLI version. */
  staleSessions(): Promise<StaleClaudeSessions> {
    return listStaleSessions(this.staleSources);
  }

  /** Restarts those of them the reader agreed to, each through `restart` and only while idle. */
  restartStale(sessionIds: readonly string[]): Promise<StaleSessionRestartResult[]> {
    return restartStaleSessions(sessionIds, {
      ...this.staleSources,
      restart: (sessionId) => this.restart({ kind: "session-tmux", source: "claude", sessionId }),
    });
  }

  /**
   * Runs a Claude session again in the pane it already has, under the launch argv in force now.
   *
   * Claude only, because the point is `configClaudeLaunch.ts`: a session keeps the permission mode
   * it was launched with until its process is replaced. The pane is replaced in place, so this
   * opens nothing and every viewer already attached keeps reading it.
   */
  async restart(context: SessionTmuxTerminalContext): Promise<void> {
    if (context.source !== "claude") {
      throw new AgentTerminalInvalidError("only a Claude session restarts under the launch flags");
    }
    const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
    const session = this.resolveSession("claude", sessionId);
    if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
    let cwd: string;
    try {
      cwd = await realpath(resolve(session.projectPath));
    } catch {
      throw new AgentTerminalConflictError("agent session project directory is no longer available");
    }
    const outcome = await this.restartPane({ sessionId, cwd });
    if (outcome.kind === "no-pane") {
      throw new AgentTerminalNotFoundError("this session is not running in a tmux pane the panel started");
    }
    if (outcome.kind === "not-ours") {
      throw new AgentTerminalConflictError(
        `tmux session ${outcome.session} was not started by the panel for this session, so restarting it would end somebody else's shell`,
      );
    }
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
      const connection = await connectTmuxTerminal(
        {
          attachments: this.tmux,
          sessionTmux: this.sessionTmux,
          stampSessionIdentity: this.stampSessionIdentity,
          relabelSession: this.relabelSession,
          revivePane: this.revivePane,
        },
        identity,
        identity.tmuxSession,
        { columns, rows },
      );
      return this.register(identity, connection);
    }

    return this.register(identity, await connectPtyTerminal(this.pty, identity, { columns, rows }));
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
    const attachment = connection.attachment;
    const descriptor: AgentTerminalDescriptor = {
      terminalId,
      ptySessionName: identity.ptySessionName,
      pid: attachment.pid,
      columns: attachment.columns,
      rows: attachment.rows,
      // Only a joined pane answers this. A PTY this service launched is watched from its first
      // byte, so its viewer learns the mouse mode from the stream the way a real terminal does and
      // has nothing to be told. See the wire descriptor's own field.
      mouseReporting: "mouseReporting" in attachment && attachment.mouseReporting,
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
      // Stripped to the session: `mouse` is a session option and the target may name a window
      // or pane, which `set-option -t` would refuse for it.
      this.restoreMouse(tmuxTargetSession(identity.tmuxSession)).catch((error: unknown) => {
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
   * Hands the resolution its four collaborators, which is all this class owes it.
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
      claudeRunning: (sessionId) => this.claudeRunning(sessionId),
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



