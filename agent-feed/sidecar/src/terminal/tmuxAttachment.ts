// Attaching to a tmux session with tmux's own primitives, instead of through the PTY manager.
//
// Why this exists: the PTY manager is a Rust daemon, and a machine that has tmux and a sidecar but
// not that daemon could list its sessions and open none of them -- which is what a remote peer
// looks like. tmux can already do every part of the job on its own:
//
//   capture-pane    the screen and its scrollback, for a viewer that has neither
//   pipe-pane       the pane's raw output, live, from the moment it is set
//   send-keys -H    arbitrary bytes in, as hex, so no key-name table is needed
//
// It deliberately does NOT resize. tmux has one window size for everyone, so a viewer that set it
// would reflow the session in its owner's own terminal.
//
// What it does NOT do is create a session. The PTY path exists to launch and own a process; this
// path only ever joins one a human already started, which is the whole point of the terminals wall.
//
// Two measured constraints shape the design, both from probing tmux directly:
//
//   A pane has ONE pipe. Setting a second `pipe-pane` does not add one, and `-o` toggles the
//   existing pipe OFF -- so a second viewer arriving would have silently blinded the first. The
//   pipe is therefore owned per SESSION and fanned out to viewers, with the last one to leave
//   closing it.
//
//   The pipe starts at now. It carries what the program writes from the moment it is set and
//   nothing before, so a joining viewer's first screen has to come from `capture-pane`. That is the
//   same split the tile's history already makes, and `terminalHistoryPayload` composes it.

import type { PtyEnvelope } from "./ptyProtocol.ts";

/** Everything this needs from tmux, injected so the logic can be tested without a tmux server. */
export interface TmuxPaneRuntime {
  /** The pane's pid and geometry, for the descriptor the panel renders. */
  describe(session: string): Promise<{ pid: number; columns: number; rows: number }>;
  /** The scrollback and the screen, composed for a terminal to write directly. */
  capture(session: string, lines: number): Promise<string>;
  /** Sets THE pipe for this pane and resolves with the function that closes it. */
  pipe(session: string, onData: (chunk: Uint8Array) => void): Promise<() => void>;
  /** Raw bytes into the pane. */
  send(session: string, bytes: Uint8Array): Promise<void>;
}

type EnvelopeListener = (envelope: PtyEnvelope) => void;
type FailureListener = (error: Error) => void;

/** How much scrollback a checkpoint hands over. Matches the route's own ceiling. */
const CHECKPOINT_LINES = 50_000;

/**
 * One pane's pipe and the viewers watching it.
 *
 * `viewers` is what decides the pipe's lifetime rather than a count, because a viewer that fails to
 * unsubscribe would otherwise leak the pane's pipe forever and there would be nothing to see it.
 */
interface SharedPane {
  readonly session: string;
  readonly viewers: Set<TmuxSessionConnection>;
  readonly stop: () => void;
  pid: number;
  columns: number;
  rows: number;
  revision: number;
}

/**
 * Bytes as the lowercase hex pairs `send-keys -H` takes.
 *
 * Hex rather than key names because the viewer sends a terminal's byte stream: printable text,
 * escape sequences for arrows, and bare control characters. Every key-name mapping is a table with
 * holes in it, and the holes are the keys an agent's composer needs.
 */
export function hexKeyArguments(bytes: Uint8Array): string[] {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
}

/** The connection surface `AgentTerminalService` uses, backed by tmux rather than a PTY. */
export class TmuxSessionConnection {
  readonly attachment: { sessionName: string; pid: number; columns: number; rows: number };
  private readonly envelopeListeners = new Set<EnvelopeListener>();
  private readonly failureListeners = new Set<FailureListener>();
  private closed = false;

  constructor(
    private readonly pane: SharedPane,
    private readonly runtime: TmuxPaneRuntime,
    private readonly release: (connection: TmuxSessionConnection) => void,
  ) {
    this.attachment = {
      sessionName: pane.session,
      pid: pane.pid,
      columns: pane.columns,
      rows: pane.rows,
    };
  }

  /** Called by the hub for pipe output, so every viewer of one pane sees the same bytes. */
  deliver(envelope: PtyEnvelope): void {
    for (const listener of this.envelopeListeners) listener(envelope);
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) listener(error);
  }

  onEnvelope(listener: EnvelopeListener): () => void {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  onFailure(listener: FailureListener): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  sendInput(data: string): void {
    this.write(new TextEncoder().encode(data));
  }

  sendBinaryInput(data: string): void {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    this.write(bytes);
  }

  /**
   * Reports the pane's geometry. It never changes it.
   *
   * A viewer used to be able to claim the size, and tmux has one window size for everyone, so the
   * claim reflowed the session in whatever terminal its owner had it open in. Measured on a live
   * Claude Code pane: a viewer opening at 80x24 shrank the window under it, and the TUI redrew
   * with its composer off the bottom of its own frame -- keystrokes were landing the whole time,
   * in a box that was no longer where the screen said it was.
   *
   * So the pane is authoritative and the viewer adopts what it finds. `isOwner` is false for the
   * same reason: nobody watching through this path owns the size.
   */
  updateViewerState(options: {
    sequence: string;
    active: boolean;
    claim: boolean;
    columns: number;
    rows: number;
  }): void {
    if (this.closed) return;
    this.deliver({
      protocolVersion: 1,
      sessionName: this.pane.session,
      terminalViewportStatus: {
        isOwner: false,
        ownerClientId: "0",
        ownerTitle: "tmux",
        sourceColumns: this.pane.columns,
        sourceRows: this.pane.rows,
        viewColumns: options.columns,
        viewRows: options.rows,
      },
    });
  }

  /**
   * The pane's screen, as a checkpoint.
   *
   * The PTY path replays a recorded stream; there is none here, so the capture IS the checkpoint.
   * One chunk rather than many because `capture-pane` returns the whole thing at once and chunking
   * a string we already hold buys nothing.
   */
  requestCheckpoint(_lastAppliedRevision: string): void {
    if (this.closed) return;
    this.pane.revision += 1;
    const revision = String(this.pane.revision);
    const checkpointId = revision;
    void this.runtime.capture(this.pane.session, CHECKPOINT_LINES)
      .then((payload) => {
        if (this.closed) return;
        const data = base64FromString(payload);
        this.deliver({
          protocolVersion: 1,
          sessionName: this.pane.session,
          terminalCheckpointBegin: {
            checkpointId,
            revision,
            columns: this.pane.columns,
            rows: this.pane.rows,
            totalBytes: String(data.length),
            chunkCount: 1,
          },
        });
        this.deliver({
          protocolVersion: 1,
          sessionName: this.pane.session,
          terminalCheckpointChunk: { checkpointId, index: 0, data },
        });
        this.deliver({
          protocolVersion: 1,
          sessionName: this.pane.session,
          terminalCheckpointEnd: { checkpointId, revision },
        });
      })
      .catch((error: unknown) => this.fail(asError(error)));
  }

  /**
   * Leaving. Never `kill-session`, whatever the caller called it.
   *
   * The PTY path distinguishes detaching from killing because it owns a process. This path owns
   * nothing but a pipe: the session belongs to whoever started it, and ending their work because a
   * browser tab closed would be the worst bug this feature could have.
   */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.release(this);
  }

  kill(): void {
    this.detach();
  }

  closeTransport(): void {
    this.detach();
  }

  private write(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    void this.runtime.send(this.pane.session, bytes)
      .catch((error: unknown) => this.fail(asError(error)));
  }
}

/**
 * One shared pipe per tmux session, handed to as many viewers as ask for it.
 *
 * Held here rather than per connection because a pane has exactly one pipe: opening a second
 * viewer's pipe closes the first viewer's, silently, and neither of them can tell.
 */
export class TmuxAttachments {
  private readonly panes = new Map<string, SharedPane>();

  constructor(private readonly runtime: TmuxPaneRuntime) {}

  /** How many sessions currently hold a pipe. For tests and diagnostics. */
  get openPanes(): number {
    return this.panes.size;
  }

  /**
   * Joins a session. `dimensions` is what the viewer would like and is deliberately ignored: the
   * pane's own size is returned instead, for the viewer to adopt. See `updateViewerState`.
   */
  async open(
    session: string,
    _dimensions: { columns: number; rows: number },
  ): Promise<TmuxSessionConnection> {
    const existing = this.panes.get(session);
    if (existing) {
      const connection = new TmuxSessionConnection(existing, this.runtime, (leaving) =>
        this.releaseViewer(existing, leaving));
      existing.viewers.add(connection);
      return connection;
    }

    const geometry = await this.runtime.describe(session);
    // Built before the pipe so the fan-out has somewhere to go the instant bytes arrive: tmux
    // starts writing as soon as `pipe-pane` returns, and output dropped on the floor here reads as
    // a terminal that is alive but frozen.
    const pane: SharedPane = {
      session,
      viewers: new Set(),
      stop: () => {},
      pid: geometry.pid,
      columns: geometry.columns,
      rows: geometry.rows,
      revision: 0,
    };
    const stop = await this.runtime.pipe(session, (chunk) => {
      const envelope: PtyEnvelope = {
        protocolVersion: 1,
        sessionName: session,
        output: { data: base64FromBytes(chunk), revision: String(pane.revision) },
      };
      for (const viewer of pane.viewers) viewer.deliver(envelope);
    });
    const seeded: SharedPane = { ...pane, stop };
    this.panes.set(session, seeded);
    const connection = new TmuxSessionConnection(seeded, this.runtime, (leaving) =>
      this.releaseViewer(seeded, leaving));
    seeded.viewers.add(connection);
    return connection;
  }

  private releaseViewer(pane: SharedPane, leaving: TmuxSessionConnection): void {
    pane.viewers.delete(leaving);
    if (pane.viewers.size > 0) return;
    this.panes.delete(pane.session);
    pane.stop();
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64FromString(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
