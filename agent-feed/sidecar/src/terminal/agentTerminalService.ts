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
  SessionForkTerminalContext,
  SessionTmuxTerminalContext,
  TmuxTerminalContext,
} from "@agentdesk/agent-feed-wire";
import { PtyManagerClient, type PtySessionConnection } from "./ptyClient.ts";
import { liveSessionProcesses } from "../tasks/sessionRegistry.ts";
import {
  captureTmuxHistory,
  createTmuxSession,
  describeTmuxPane,
  hexSend,
  pipeTmuxPane,
  restoreTmuxMouse,
  tmuxSessionExists,
} from "./tmuxSessions.ts";
import { TmuxAttachments, type TmuxSessionConnection } from "./tmuxAttachment.ts";
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
  /**
   * When set, `tmuxSession` may be started rather than only joined, running this.
   *
   * Only the session-backed kind carries it. A tmux target named by the panel is somebody else's
   * session and creating it would answer a typo with a new process; a session-backed one is a
   * session id that the sidecar resolved to a pane name itself, so there is nothing to mistype.
   */
  createTmux: { cwd: string; command: string[] } | null;
}

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
    } = { owner: liveTmuxSession, exists: tmuxSessionExists, create: createTmuxSession },
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
      if (identity.createTmux && !(await this.tmuxExists(identity.tmuxSession))) {
        await this.startTmux(identity.createTmux, identity.tmuxSession, { columns, rows });
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
    if (context.kind === "session-tmux") return this.identifySessionTmux(context);
    if (context.kind === "session-fork") return this.identifySessionFork(context);
    return this.identifyAgentSession(context);
  }

  /**
   * Attaching, not resuming: the process is already running and tmux is what allows a second
   * viewer.
   *
   * The name is validated here rather than at the tmux call, because every tmux verb takes it as
   * `-t <session>` on an argument vector this process builds -- so a name that is not a plain
   * identifier is refused once, at the door, instead of at each of five call sites.
   *
   * `command` is empty and `cwd` is nominal: nothing is launched on this path. They stay on the
   * shared identity shape because the PTY path needs them, and `ptySessionName` stays because the
   * descriptor carries it as the terminal's label on both backends.
   */
  private identifyTmux(context: TmuxTerminalContext): TerminalIdentity {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(context.session)) {
      throw new AgentTerminalInvalidError("tmux session name is not a plain identifier");
    }
    return {
      ptySessionName: `agent-tmux-${context.session}`,
      tmuxSession: context.session,
      cwd: this.userHomeDirectory,
      command: [],
      // A tmux session is meant to be watched from more than one place, so nothing to refuse.
      refuseNew: null,
      createTmux: null,
    };
  }

  private async identifyAgentSession(
    context: AgentSessionTerminalContext,
  ): Promise<TerminalIdentity> {
    if (context.source !== "claude" && context.source !== "codex") {
      throw new AgentTerminalInvalidError("terminal source must be claude or codex");
    }
    const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
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

    // A shell in the session's own directory, not a resumed agent.
    //
    // This used to launch `claude --resume <id>` (or `codex resume`), which made the terminal
    // control unusable exactly when it was most wanted: resuming a session that is already running
    // opens a second client to one transcript, so a LIVE session -- the common case -- was refused
    // and the pane never appeared at all. What the control is for is a terminal where that work is
    // happening; the running session is already watchable through its own tmux pane.
    //
    // `command` empty means the login shell itself, resolved in `open`.
    return {
      ptySessionName: `agent-shell-${context.source}-${sessionId}`,
      tmuxSession: null,
      cwd: projectPath,
      command: [],
      refuseNew: null,
      createTmux: null,
    };
  }

  /**
   * The session's own tmux pane: the one it is running in, or one started to resume it.
   *
   * Which of the two it is cannot be decided by the caller. A panel asking "is this session in
   * tmux" gets null for a session running outside tmux and null again for one that is not running,
   * so it cannot tell a pane it should join from one it should start -- and by the time it acted on
   * either answer the session could have exited. Deciding it here also makes the pane name the
   * sidecar's: derived from the session id, so a second viewer of the same session lands on the
   * same pane instead of starting a second resume of one transcript.
   *
   * Resuming a session that is live SOMEWHERE ELSE -- a Claude Desktop window, say -- opens a
   * second client to one transcript. That is why the resume is the fallback rather than the first
   * move, and why the pane keeps a shell after the command exits: a CLI that refuses says so, and
   * the reason stays on screen.
   */
  private async identifySessionTmux(
    context: SessionTmuxTerminalContext,
  ): Promise<TerminalIdentity> {
    if (context.source !== "claude" && context.source !== "codex") {
      throw new AgentTerminalInvalidError("terminal source must be claude or codex");
    }
    const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
    const session = this.resolveSession(context.source, sessionId);
    if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
    let projectPath: string;
    try {
      projectPath = await realpath(resolve(session.projectPath));
    } catch {
      throw new AgentTerminalConflictError("agent session project directory is no longer available");
    }

    // The live process's own pane wins, and is joined rather than created: it is where the work is
    // actually happening, and it belongs to whoever started it.
    const owned = await this.sessionTmux.owner(context.source, sessionId);
    if (owned) {
      return {
        ptySessionName: `agent-tmux-${owned}`,
        tmuxSession: owned,
        cwd: projectPath,
        command: [],
        refuseNew: null,
        createTmux: null,
      };
    }

    const pane = resumedPaneName(sessionId);
    return {
      ptySessionName: `agent-tmux-${pane}`,
      tmuxSession: pane,
      cwd: projectPath,
      command: [],
      refuseNew: null,
      createTmux: {
        cwd: projectPath,
        command: context.source === "claude"
          ? ["claude", "--resume", sessionId]
          : ["codex", "resume", sessionId],
      },
    };
  }

  /**
   * A new session forked from an existing transcript.
   *
   * Deliberately the opposite of the resume above in the one way that matters: it NEVER joins a
   * live pane. Resuming asks "where is this session", and joining is right because two viewers of
   * one transcript should not become two clients of it. Forking asks for a session that did not
   * exist a moment ago, so there is nothing to join, and joining would be the bug -- it would put
   * the reader back in the transcript they asked to branch away from.
   *
   * The pane is named after the fork rather than its source, so forking one session twice gives
   * two panes rather than one pane the second fork silently lands in.
   *
   * `--fork-session` copies from the source's LAST COMPACTION forward, not its whole history.
   * Measured on a transcript with compactions at lines 419 and 653 of 1247: the fork carried lines
   * 686 onward and no earlier record, including under the CLI's own "resume full session as-is"
   * option. Anything before that boundary stays in the source's file and is not in the fork's.
   */
  private async identifySessionFork(
    context: SessionForkTerminalContext,
  ): Promise<TerminalIdentity> {
    if (context.source !== "claude") {
      throw new AgentTerminalInvalidError("only claude sessions can be forked");
    }
    const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
    const forkId = requiredSessionUuid(context.forkId, "terminal fork id");
    const session = this.resolveSession(context.source, sessionId);
    if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
    let projectPath: string;
    try {
      projectPath = await realpath(resolve(session.projectPath));
    } catch {
      throw new AgentTerminalConflictError("agent session project directory is no longer available");
    }

    const pane = forkedPaneName(forkId);
    return {
      ptySessionName: `agent-tmux-${pane}`,
      tmuxSession: pane,
      cwd: projectPath,
      command: [],
      refuseNew: null,
      createTmux: {
        cwd: projectPath,
        command: ["claude", "--resume", sessionId, "--fork-session"],
      },
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

/**
 * The tmux session a live process for that session id is running inside, if any.
 *
 * Claude only: its harness is what writes the process registry this reads, so a Codex session has
 * nothing to look up and answers "none" -- which lands it on the resume path, the same place a
 * Claude session that is not running lands.
 *
 * More than one row can claim one session id, and routinely does: a session resumed by the path
 * below registers itself under the same id as the session it resumed, so from the second open
 * onwards there are two panes to choose from. Measured on this machine with three rows for one id.
 * Somebody else's terminal wins, and the one this sidecar started is the fallback -- picking by
 * registry order would move a thread's terminal between two panes for no visible reason.
 */
export async function liveTmuxSession(
  source: "claude" | "codex",
  sessionId: string,
  processes: () => Promise<{ sessionId: string; tmuxSession: string | null }[]> =
    liveSessionProcesses,
): Promise<string | null> {
  if (source !== "claude") return null;
  const panes = (await processes())
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.tmuxSession)
    .filter((pane): pane is string => pane !== null);
  return panes.find((pane) => pane !== resumedPaneName(sessionId)) ?? panes[0] ?? null;
}

/**
 * A canonical lower-case UUID, or a refusal naming which field was wrong.
 *
 * A pane name is derived from these, so a value that is merely close enough would put two
 * different requests on one pane.
 */
function requiredSessionUuid(value: string, field: string): string {
  const canonical = value.toLowerCase();
  if (!UUID_PATTERN.test(canonical) || value !== canonical) {
    throw new AgentTerminalInvalidError(`${field} must be a canonical UUID`);
  }
  return canonical;
}

/** The pane a fork runs in, named for the fork rather than the session it came from. */
function forkedPaneName(forkId: string): string {
  return `agentdesk-fork-${forkId}`;
}

/**
 * The pane name this sidecar resumes a session into.
 *
 * Derived from the session id rather than random so a second viewer of one session lands on the
 * first's pane instead of starting a second resume of one transcript, and shared with the owner
 * lookup above so the two agree on which pane is ours.
 */
function resumedPaneName(sessionId: string): string {
  return `agentdesk-${sessionId}`;
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
