import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type {
  AgentSessionTerminalContext,
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
  TmuxTerminalContext,
} from "@agentdesk/agent-feed-wire";
import { PtyManagerClient, type PtySessionConnection } from "./ptyClient.ts";
import { captureTmuxHistory, restoreTmuxMouse } from "./tmuxSessions.ts";
import type { PtyEnvelope, PtySessionSummary } from "./ptyProtocol.ts";

const BOOTSTRAP_COLUMNS = 80;
const BOOTSTRAP_ROWS = 24;
const MAXIMUM_INPUT_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AgentTerminalInvalidError extends Error {}
export class AgentTerminalNotFoundError extends Error {}
export class AgentTerminalConflictError extends Error {}
export class AgentTerminalUnavailableError extends Error {}

export interface ResolvedAgentTerminalSession {
  projectPath: string;
  activity: string;
}

/** Everything `open` needs that depends on what the terminal is pointed at. */
interface TerminalIdentity {
  ptySessionName: string;
  /** Set for a tmux attach; the history and the mouse setting are that session's, not ours. */
  tmuxSession: string | null;
  cwd: string;
  /** Argv for the login shell to exec, command first. */
  command: string[];
  /** When set, a target with no PTY session yet must not get one, and this says why. */
  refuseNew: string | null;
}

interface ActiveTerminal {
  descriptor: AgentTerminalDescriptor;
  connection: PtySessionConnection;
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
  ) {
  }

  async open(
    context: AgentTerminalContext,
    dimensions: { columns: number; rows: number },
  ): Promise<AgentTerminalDescriptor> {
    const identity = await this.identify(context);
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

    const columns = requiredDimension(dimensions.columns, "terminal columns");
    const rows = requiredDimension(dimensions.rows, "terminal rows");
    let connection: PtySessionConnection;
    try {
      connection = await this.pty.openSession({
        sessionName: identity.ptySessionName,
        launch: {
          cwd: identity.cwd,
          executable: "/bin/zsh",
          // Through a login shell, so the command is found on the user's own PATH rather than the
          // sidecar's, which is deliberately stripped of it.
          arguments: ["-l", "-c", 'exec "$0" "$@"', ...identity.command],
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
   * What to launch, where, and under which PTY session name.
   *
   * One place rather than a branch inside `open`, because the two kinds of terminal agree on
   * everything after this: the pty session is deterministic per target, so a second viewer of the
   * same target joins the running one instead of starting a second.
   */
  private async identify(context: AgentTerminalContext): Promise<TerminalIdentity> {
    if (context.kind === "tmux") return this.identifyTmux(context);
    return this.identifyAgentSession(context);
  }

  /**
   * Attaching, not resuming: the process is already running and tmux is what allows a second
   * viewer. tmux 3.x negotiates window size as `window-size latest`, so this viewer's own
   * dimensions win while it is the client most recently used -- the user's terminal is not shrunk
   * for good, but it will letterbox until they touch it again.
   */
  private identifyTmux(context: TmuxTerminalContext): TerminalIdentity {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(context.session)) {
      throw new AgentTerminalInvalidError("tmux session name is not a plain identifier");
    }
    return {
      ptySessionName: `agent-tmux-${context.session}`,
      tmuxSession: context.session,
      cwd: this.userHomeDirectory,
      command: ["tmux", "attach-session", "-t", context.session],
      // A tmux session is meant to be watched from more than one place, so nothing to refuse.
      refuseNew: null,
    };
  }

  private async identifyAgentSession(
    context: AgentSessionTerminalContext,
  ): Promise<TerminalIdentity> {
    if (context.source !== "claude" && context.source !== "codex") {
      throw new AgentTerminalInvalidError("terminal source must be claude or codex");
    }
    const sessionId = context.sessionId.toLowerCase();
    if (!UUID_PATTERN.test(sessionId) || context.sessionId !== sessionId) {
      throw new AgentTerminalInvalidError("terminal session id must be a canonical UUID");
    }
    if (!context.projectPath.startsWith("/")) {
      throw new AgentTerminalInvalidError("terminal project path must be absolute");
    }

    let projectPath: string;
    let homePath: string;
    try {
      [projectPath, homePath] = await Promise.all([
        realpath(resolve(context.projectPath)),
        realpath(resolve(this.userHomeDirectory)),
      ]);
      if (!(await stat(projectPath)).isDirectory()) {
        throw new AgentTerminalInvalidError("terminal project path must be a directory");
      }
    } catch (error) {
      if (error instanceof AgentTerminalInvalidError) throw error;
      throw new AgentTerminalInvalidError("terminal project directory does not exist");
    }
    const fromHome = relative(homePath, projectPath);
    if (!fromHome || fromHome.startsWith("..") || fromHome.startsWith("/")) {
      throw new AgentTerminalInvalidError("terminal project directory must be inside the user home");
    }

    const session = this.resolveSession(context.source, sessionId);
    if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
    let catalogProject: string;
    try {
      catalogProject = await realpath(resolve(session.projectPath));
    } catch {
      throw new AgentTerminalConflictError("agent session project directory is no longer available");
    }
    if (catalogProject !== projectPath) {
      throw new AgentTerminalConflictError("agent session belongs to another project directory");
    }

    return {
      ptySessionName: `agent-resume-${context.source}-${sessionId}`,
      tmuxSession: null,
      cwd: projectPath,
      command: context.source === "claude"
        ? ["claude", "--resume", sessionId]
        : ["codex", "resume", sessionId],
      // Resuming a session that is already running elsewhere would open a second client to one
      // transcript. Watching it is what the tmux kind is for.
      refuseNew: session.activity === "live"
        ? "the agent session is already active in another terminal"
        : null,
    };
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

function requiredDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new AgentTerminalInvalidError(`${name} must be an integer between 1 and 1000`);
  }
  return value;
}

function decodedBase64Length(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AgentTerminalInvalidError("base64 terminal input is malformed");
  }
  return Buffer.from(value, "base64").byteLength;
}

function isRunning(session: PtySessionSummary): boolean {
  return session.state === "SESSION_STATE_RUNNING" || session.state === 1;
}

function streamMessage(envelope: PtyEnvelope): AgentTerminalStreamMessage | null {
  if (envelope.output) {
    return {
      type: "output",
      revision: envelope.output.revision ?? "0",
      data: envelope.output.data ?? "",
    };
  }
  if (envelope.terminalCheckpointBegin) {
    const value = envelope.terminalCheckpointBegin;
    return {
      type: "checkpointBegin",
      checkpointId: value.checkpointId ?? "0",
      revision: value.revision ?? "0",
      columns: value.columns ?? BOOTSTRAP_COLUMNS,
      rows: value.rows ?? BOOTSTRAP_ROWS,
      totalBytes: value.totalBytes ?? "0",
      chunkCount: value.chunkCount ?? 0,
      historyTruncated: value.historyTruncated ?? false,
    };
  }
  if (envelope.terminalCheckpointChunk) {
    const value = envelope.terminalCheckpointChunk;
    return {
      type: "checkpointChunk",
      checkpointId: value.checkpointId ?? "0",
      index: value.index ?? 0,
      data: value.data ?? "",
    };
  }
  if (envelope.terminalCheckpointEnd) {
    return {
      type: "checkpointEnd",
      checkpointId: envelope.terminalCheckpointEnd.checkpointId ?? "0",
      revision: envelope.terminalCheckpointEnd.revision ?? "0",
    };
  }
  if (envelope.terminalViewportStatus) {
    const value = envelope.terminalViewportStatus;
    return {
      type: "viewport",
      ownershipEpoch: value.ownershipEpoch ?? "0",
      ownerClientId: value.ownerClientId ?? "0",
      ownerTitle: value.ownerTitle ?? "",
      isOwner: value.isOwner ?? false,
      sourceColumns: value.sourceColumns ?? BOOTSTRAP_COLUMNS,
      sourceRows: value.sourceRows ?? BOOTSTRAP_ROWS,
      sourceRevision: value.sourceRevision ?? "0",
      viewColumns: value.viewColumns ?? BOOTSTRAP_COLUMNS,
      viewRows: value.viewRows ?? BOOTSTRAP_ROWS,
    };
  }
  if (envelope.sessionExited) return { type: "exited", status: envelope.sessionExited.status ?? 0 };
  if (envelope.clientDetached) return { type: "detached" };
  if (envelope.error) return { type: "error", message: envelope.error.message ?? "PTY manager error" };
  return null;
}
