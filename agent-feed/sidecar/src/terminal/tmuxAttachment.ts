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
// It resizes ONLY when tmux reports no clients attached. tmux has one window size for everyone, so
// a viewer that set it while a human was attached would reflow the session inside their own
// terminal -- which is exactly the bug that made this module stop resizing at all. The condition
// that made it harmful is somebody else watching, and tmux can be asked that directly, so the
// guard is the client count rather than a blanket refusal. See `adoptPaneSize`.
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
  /**
   * Sets THE pipe for this pane and resolves with the function that closes it.
   *
   * Closing RESOLVES when tmux has been told, so an off and a following on cannot land in the
   * wrong order. See `open`.
   */
  pipe(session: string, onData: (chunk: Uint8Array) => void): Promise<() => Promise<void>>;
  /** Raw bytes into the pane. */
  send(session: string, bytes: Uint8Array): Promise<void>;
  /** How many real tmux clients are attached. Throws when it cannot tell. */
  clients(session: string): Promise<number>;
  /** Sets the window size, which is every client's. Guarded by `clients` at the call site. */
  resize(session: string, columns: number, rows: number): Promise<void>;
  /** Lifts the `window-size manual` pin that resizing leaves behind, keeping the size. */
  releaseSize(session: string): Promise<void>;
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
  readonly stop: () => Promise<void>;
  pid: number;
  columns: number;
  rows: number;
  revision: number;
  /** The shape the most recent viewport report asked for, waiting for the applier to reach it. */
  wanted: { columns: number; rows: number } | null;
  /** The applier, while one is running. Present means a later ask joins it instead of racing it. */
  resizing: Promise<void> | null;
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
   * Asks the pane to become the shape this viewer's box wants, then reports what it actually is.
   *
   * Always reports, whether the resize happened, was refused or failed. A viewer that hears
   * nothing back cannot tell a pane it does not own from a sidecar that dropped the message, and
   * the two need different reactions: the first is scaled to, the second is a bug.
   *
   * `isOwner` is therefore derived rather than asserted -- true exactly when the pane came out the
   * shape that was asked for. That makes the footer a live read of whether this viewer's size is
   * the one in force, which is the diagnostic a reader wants when the type looks wrong.
   */
  updateViewerState(options: {
    sequence: string;
    active: boolean;
    claim: boolean;
    columns: number;
    rows: number;
  }): void {
    if (this.closed) return;
    void adoptPaneSize(this.runtime, this.pane, options.columns, options.rows)
      .catch((error: unknown) => {
        // Not a failure of the terminal. A pane that would not change shape is the case this
        // viewer already handles by scaling its own type, which is what it did before it could
        // resize at all -- so it is reported and the report below still goes out.
        console.error(`tmux pane ${this.pane.session} could not adopt a viewer's size`, asError(error));
      })
      .finally(() => {
        if (this.closed) return;
        this.deliver({
          protocolVersion: 1,
          sessionName: this.pane.session,
          terminalViewportStatus: {
            isOwner: this.pane.columns === options.columns && this.pane.rows === options.rows,
            ownerClientId: "0",
            ownerTitle: "tmux",
            sourceColumns: this.pane.columns,
            sourceRows: this.pane.rows,
            viewColumns: options.columns,
            viewRows: options.rows,
          },
        });
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
 * Makes the pane the shape a viewer asked for, when tmux says nobody else is watching.
 *
 * The guard is the whole design. tmux has ONE window size per session, so setting it is setting it
 * for every client -- and the last time this repo resized panes, a tile opening at 80x24 reflowed a
 * live Claude Code TUI inside the human's own terminal and left its composer drawing off the bottom
 * of its frame. What made that harmful was a client being attached, and tmux answers that question
 * directly, so the resize is conditional rather than forbidden. Being a real tmux client instead
 * would not help: measured, a control-mode client's `refresh-client -C` reshapes the window for
 * everyone the same way, and the window keeps the new shape after that client detaches.
 *
 * LATEST WINS, deliberately, and it is also what tmux's own `window-size latest` means. Two cards
 * on one session are two boxes of different shapes with one answer between them; the alternative,
 * largest, hands the smaller card a grid it has to shrink its type to read, which is the problem
 * this exists to remove.
 *
 * KNOWN DEFECT, and the reason to care about the paragraph above: two viewers of DIFFERENT widths
 * on one pane make it OSCILLATE, and this does not damp. Each open viewer republishes its own box
 * on every checkpoint and every move sends a checkpoint, so the two trade the window forever.
 * Measured at 48x16 against 132x40: 145 transitions in 400 samples over half a minute, roughly
 * five a second, with the pane spending 194 samples at 132 and 164 at 48. A TUI on that pane
 * reflows every time.
 *
 * One viewer per pane is every arrangement this repo actually makes today, which is why it ships,
 * but a second card on one session is one click away and there is no guard. The fix, when it is
 * wanted, is to let the most recent SUBSCRIBER own the shape until it leaves, rather than the most
 * recent report -- that keeps latest-wins for the case it was chosen for and stops the fight.
 *
 * Measure this at 50ms or finer. At 500ms a five-a-second oscillation aliases into what looks like
 * a settled pane: the first run of this test read four transitions and thirty still seconds, and
 * that reading is what the comment here used to claim. The tell was the checkpoint count -- 447 per
 * viewer against four apparent moves -- and the number that is not aliased is the checkpoint count,
 * because one move sends exactly one. And do NOT try this from two browser tabs: a backgrounded tab
 * stops rendering and stops publishing, so it holds no shape and there is only ever one viewer.
 * Two API clients against a private sidecar is what worked.
 *
 * Bursts collapse rather than queue: the loop re-reads `wanted` each time round, so a drag that
 * reports twenty sizes costs the tmux calls for the last one plus whichever was in flight.
 */
async function adoptPaneSize(
  runtime: TmuxPaneRuntime,
  pane: SharedPane,
  columns: number,
  rows: number,
): Promise<void> {
  pane.wanted = { columns, rows };
  // Joining the running applier rather than starting a second: two resizes racing on one window
  // land in an order neither caller chose, and the loser's shape is what sticks.
  if (pane.resizing) return pane.resizing;
  const applier = (async () => {
    for (let want = pane.wanted; want !== null; want = pane.wanted) {
      pane.wanted = null;
      if (want.columns === pane.columns && want.rows === pane.rows) continue;
      // Asked every pass, not once: a human can attach between two reports, and the whole
      // guarantee is that this never reshapes a session somebody is sitting in front of.
      if (await runtime.clients(pane.session) > 0) return;
      await runtime.resize(pane.session, want.columns, want.rows);
      // Handed straight back. `resize-window -x -y` pins the window to `window-size manual` as a
      // side effect -- measured, and it is what left four sessions stuck that way the last time
      // this repo resized panes. Unsetting keeps the size and restores tmux's own negotiation, so
      // a human who attaches a moment later gets their own terminal's shape at once instead of
      // the 44x23 some card left behind. Measured end to end: resize to 44x23, unset, attach a
      // client at 150x45, window is 150x45.
      //
      // Immediately rather than when the last viewer leaves, which is where this lived first: a
      // pin held for the life of a card is a pin held across exactly the window in which somebody
      // might attach, which is the case it exists to protect.
      await runtime.releaseSize(pane.session);
      // Read back rather than assumed. tmux clamps a window to what its layout can hold, so the
      // shape that lands is not always the shape that was asked for, and the viewer is about to
      // render against whichever it really is.
      const geometry = await runtime.describe(pane.session);
      const moved = geometry.columns !== pane.columns || geometry.rows !== pane.rows;
      pane.columns = geometry.columns;
      pane.rows = geometry.rows;
      if (!moved) continue;
      // Fanned out HERE, once per actual move, rather than from the caller's continuation.
      //
      // Every caller that arrived while an applier was running is handed that applier's promise,
      // so a `.then` on it runs once PER CALLER. One real resize with forty reports queued behind
      // it therefore sent forty checkpoints to every viewer, each of which clears and repaints a
      // whole terminal, and each of which makes a viewer republish -- which queues more callers.
      // Measured before this moved: two viewers on one pane made it change shape four times and
      // then hold, while sending 894 viewport reports and taking 447 checkpoints EACH over the
      // following half minute. The pane was right and the redraws were a storm.
      for (const viewer of pane.viewers) viewer.requestCheckpoint("");
    }
  })();
  pane.resizing = applier;
  // Cleared from OUTSIDE the applier, and this is not a style choice. An applier whose every
  // iteration hits the `continue` above finishes SYNCHRONOUSLY, so a `finally` written inside it
  // runs before `pane.resizing` is even assigned -- and the assignment then latches a settled
  // promise that nothing ever clears. Every later report joins it and returns without resizing.
  // Measured on three live cards: each reached a size, took one report that matched it, and then
  // ignored every ask after that, sitting six or seven columns short of the box for good.
  void applier.finally(() => {
    if (pane.resizing === applier) pane.resizing = null;
    // Swallowed HERE only. The applier's rejection is the caller's to report -- this branch of it
    // exists to clear the latch, and leaving it unhandled makes a failed tmux call an unhandled
    // rejection as well as a logged one.
  }).catch(() => {});
  return applier;
}

/**
 * One shared pipe per tmux session, handed to as many viewers as ask for it.
 *
 * Held here rather than per connection because a pane has exactly one pipe: opening a second
 * viewer's pipe closes the first viewer's, silently, and neither of them can tell.
 */
export class TmuxAttachments {
  private readonly panes = new Map<string, SharedPane>();
  /**
   * Panes whose pipe is being torn down, so a viewer arriving now waits for it.
   *
   * A pane has ONE pipe, and both setting and clearing it are tmux commands that take a moment. A
   * viewer leaving and another arriving straight after -- which is what a card being toggled, or a
   * reader moving between two cards on one session, actually is -- issue a clear and a set with
   * nothing ordering them. Measured during a burst of that: `pane_pipe` read 0 while three viewers
   * were attached, and 1 while none were. The first is a terminal that shows its imported screen
   * and then never moves again, which reads as a frozen session rather than as a lost pipe.
   */
  private readonly closing = new Map<string, Promise<void>>();

  constructor(private readonly runtime: TmuxPaneRuntime) {}

  /** How many sessions currently hold a pipe. For tests and diagnostics. */
  get openPanes(): number {
    return this.panes.size;
  }

  /**
   * Joins a session, at whatever shape it currently is.
   *
   * `dimensions` is not applied here. The viewer publishes its box a moment later and that report
   * is what resizes the pane, so the sizing lives in one place instead of two that can disagree --
   * and joining first means a pane that refuses to resize still opens and still shows its screen.
   */
  async open(
    session: string,
    _dimensions: { columns: number; rows: number },
  ): Promise<TmuxSessionConnection> {
    // Behind any teardown for this pane, so the new pipe is set after the old one is cleared
    // rather than racing it.
    const closing = this.closing.get(session);
    if (closing) await closing;
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
      stop: async () => {},
      pid: geometry.pid,
      columns: geometry.columns,
      rows: geometry.rows,
      revision: 0,
      wanted: null,
      resizing: null,
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
    // Recorded rather than awaited: releasing is called from a viewer detaching, which cannot
    // block. `open` is what waits.
    const closed = pane.stop().catch((error: unknown) => {
      console.error(`tmux pane ${pane.session} did not release its pipe`, asError(error));
    });
    this.closing.set(pane.session, closed);
    void closed.finally(() => {
      // Only if no later teardown has replaced it, or a slow close would clear a fast one's entry.
      if (this.closing.get(pane.session) === closed) this.closing.delete(pane.session);
    });
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
