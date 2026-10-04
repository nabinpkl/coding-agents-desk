// Where the Mac's cursor is, as this viewer believes it, and the only thing that moves it.
//
// One per viewer, shared by every surface that drives the pointer: the picture in Pointer mode,
// the trackpad, the drag. Two copies would be two answers to "where is the cursor", and the drawn
// cursor would drift away from the Mac's by whatever one surface did that the other did not see.
// So surfaces send relative moves and warps through here, and draw whatever this says.
//
// It predicts: a move is drawn the moment it is sent. `CursorReconciliation` decides when the
// Mac's own reports correct that prediction, and when it has gone unconfirmed long enough to be
// drawn as a ghost.

import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import {
  CursorReconciliation,
  type CursorConfidence,
  type CursorOperation,
  type CursorPoint,
} from "@/features/desktop-viewer/pointer-input/cursorReconciliation";

/** Why the cursor changed, so a listener can tell its own move from the Mac's word. */
export type RemoteCursorChange = "local" | "host" | "confidence" | "reset";

export interface RemoteCursorOptions {
  /** True when the transport took the input. */
  send: (input: DesktopPointerInput) => boolean;
  /** Milliseconds. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  reconciliation?: CursorReconciliation;
}

export class RemoteCursor {
  private point: CursorPoint = { x: 0, y: 0 };
  private width = 0;
  private height = 0;
  private readonly listeners = new Set<(change: RemoteCursorChange) => void>();
  private readonly reconciliation: CursorReconciliation;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private deadlineTimer = 0;
  private readonly send: (input: DesktopPointerInput) => boolean;

  constructor(options: RemoteCursorOptions) {
    this.send = options.send;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
    this.reconciliation = options.reconciliation ?? new CursorReconciliation();
  }

  get position(): CursorPoint {
    return this.point;
  }

  get sourceWidth(): number {
    return this.width;
  }

  get sourceHeight(): number {
    return this.height;
  }

  get confidence(): CursorConfidence {
    return this.reconciliation.confidence;
  }

  subscribe(listener: (change: RemoteCursorChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A new display, or a fresh look at the old one: forget every guess and start from `initial`. */
  reset(source: { width: number; height: number }, initial?: CursorPoint): void {
    this.width = Math.max(0, source.width);
    this.height = Math.max(0, source.height);
    this.reconciliation.reset();
    this.cancelDeadline();
    this.point = this.clamp(initial ?? { x: this.width / 2, y: this.height / 2 });
    this.notify("reset");
  }

  /**
   * A relative move, sent numbered and drawn at once. Mirrors the Mac's current + delta + clamp,
   * so the guess lands where the Mac will put it. False when it did not go out.
   */
  move(dx: number, dy: number): boolean {
    const sent = this.sendTracked({ kind: "move", dx, dy }, (revision) => ({
      type: "pointer-move", revision, dx, dy,
    }));
    if (sent && this.width > 0 && this.height > 0) {
      this.point = this.clamp({ x: this.point.x + dx, y: this.point.y + dy });
      this.notify("local");
    }
    return sent;
  }

  /** An absolute placement in the display's own coordinates, for a mouse. */
  warp(to: CursorPoint): boolean {
    if (this.width <= 0 || this.height <= 0) return false;
    const target = this.clamp(to);
    if (Math.round(target.x) === Math.round(this.point.x)
        && Math.round(target.y) === Math.round(this.point.y)) return false;
    const sent = this.sendTracked({ kind: "set", to: target }, (revision) => ({
      type: "pointer-warp", revision, x: target.x, y: target.y,
    }));
    if (sent) {
      this.point = target;
      this.notify("local");
    }
    return sent;
  }

  /** The Mac's word about its cursor: an acknowledged move, or movement of its own. */
  applyEvent(event: Extract<WebrtcCursorEvent, { type: "cursor-applied" | "cursor-position" }>): void {
    const now = this.now();
    const reported = { x: event.x, y: event.y };
    if (event.type === "cursor-applied") {
      const corrected = this.reconciliation.applyHostApplied(event.revision, this.clamp(reported), now);
      if (corrected) {
        this.point = corrected;
        this.notify("host");
      } else {
        this.notify("confidence");
      }
    } else {
      this.point = this.reconciliation.applyHostMoved(reported, (point) => this.clamp(point), now);
      this.notify("host");
    }
    this.scheduleDeadline();
  }

  dispose(): void {
    this.cancelDeadline();
    this.listeners.clear();
  }

  private sendTracked(
    operation: CursorOperation,
    input: (revision: number) => DesktopPointerInput,
  ): boolean {
    const now = this.now();
    const revision = this.reconciliation.record(operation, now);
    if (revision === null) {
      // Too many guesses unconfirmed: sending another untracked one would make the drawing a lie.
      this.notify("confidence");
      return false;
    }
    const sent = this.send(input(revision));
    if (!sent) {
      this.reconciliation.markSendFailed(revision);
      this.notify("confidence");
    }
    this.scheduleDeadline();
    return sent;
  }

  /** Wakes up when the oldest guess would turn into a ghost, and redraws if it did. */
  private scheduleDeadline(): void {
    this.cancelDeadline();
    if (this.reconciliation.confidence === "ghost") return;
    const deadline = this.reconciliation.ghostDeadline;
    if (deadline === null) return;
    this.deadlineTimer = this.setTimer(() => {
      this.deadlineTimer = 0;
      const before = this.reconciliation.confidence;
      this.reconciliation.advance(this.now());
      if (this.reconciliation.confidence !== before) this.notify("confidence");
      this.scheduleDeadline();
    }, Math.max(0, deadline - this.now()));
  }

  private cancelDeadline(): void {
    if (this.deadlineTimer !== 0) this.clearTimer(this.deadlineTimer);
    this.deadlineTimer = 0;
  }

  private clamp(point: CursorPoint): CursorPoint {
    return {
      x: Math.min(Math.max(0, point.x), Math.max(0, this.width - 1)),
      y: Math.min(Math.max(0, point.y), Math.max(0, this.height - 1)),
    };
  }

  private notify(change: RemoteCursorChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
