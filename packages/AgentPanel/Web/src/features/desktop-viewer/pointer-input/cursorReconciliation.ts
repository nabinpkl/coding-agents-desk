// Whether the cursor this viewer draws is the Mac's, or only a guess the Mac has not confirmed.
//
// A port of the iPhone client's `CursorReconciliationStateMachine` (ADR-0058). Every relative
// move is sent with a revision and drawn at once, before the Mac has applied it, because waiting a
// round trip to draw a pointer is a pointer that lags the finger. This tracks those guesses: which
// are still pending, how far the Mac has caught up, and how much the drawing can be trusted. It
// owns no position of its own; the cursor model does (`remoteCursor.ts`).
//
// One difference from the Swift, and it is the channel's: the iPhone's host told the client which
// revision a host-side movement came after, because its input and its cursor reports travelled on
// different streams. Here both travel on one ordered data channel (`tileControlChannel.ts`,
// `ordered: true`), so by the time a `cursor-position` arrives, every `cursor-applied` the Mac sent
// before it has arrived too. What is still pending at that moment is exactly what the Mac had not
// applied when it looked, which is the revision the Swift needed the host to name.

export type CursorConfidence = "confirmed" | "awaiting-host" | "ghost";

export interface CursorPoint {
  x: number;
  y: number;
}

export type CursorOperation =
  | { kind: "set"; to: CursorPoint }
  | { kind: "move"; dx: number; dy: number };

export const DEFAULT_PENDING_OPERATION_LIMIT = 4_096;
/**
 * Grace before an unconfirmed prediction is drawn as a ghost. `Config.cursorConfirmationTimeoutMs`
 * in the Swift client: longer than a normal round trip, short enough that a Mac which stopped
 * applying input shows it quickly.
 */
export const CURSOR_CONFIRMATION_TIMEOUT_MS = 250;

interface PendingOperation {
  revision: number;
  operation: CursorOperation;
  sentAt: number;
}

/** Clamps a point into the display the way the Mac does: [0, w-1] x [0, h-1]. */
export type CursorClamp = (point: CursorPoint) => CursorPoint;

export class CursorReconciliation {
  private nextRevision = 1;
  private lastAppliedRevision = 0;
  private pending: PendingOperation[] = [];
  private state: CursorConfidence = "confirmed";

  constructor(
    private readonly confirmationTimeoutMs = CURSOR_CONFIRMATION_TIMEOUT_MS,
    private readonly pendingOperationLimit = DEFAULT_PENDING_OPERATION_LIMIT,
  ) {
    if (!(confirmationTimeoutMs > 0)) throw new Error("cursor confirmation timeout must be positive");
    if (!(pendingOperationLimit > 0)) throw new Error("pending cursor operation limit must be positive");
  }

  get confidence(): CursorConfidence {
    return this.state;
  }

  get pendingRevisions(): number[] {
    return this.pending.map((entry) => entry.revision);
  }

  /** When the oldest unconfirmed guess turns into a ghost, or null when nothing is pending. */
  get ghostDeadline(): number | null {
    const oldest = this.pending[0];
    return oldest ? oldest.sentAt + this.confirmationTimeoutMs : null;
  }

  /**
   * Numbers an operation about to be sent. Null is deliberate backpressure: the caller must not
   * send an untracked move, and the ghost stays until the Mac catches up or the session resets.
   */
  record(operation: CursorOperation, sentAt: number): number | null {
    if (this.pending.length >= this.pendingOperationLimit) {
      this.state = "ghost";
      return null;
    }
    const revision = this.nextRevision;
    this.nextRevision += 1;
    this.pending.push({ revision, operation, sentAt });
    if (this.state === "confirmed") this.state = "awaiting-host";
    return revision;
  }

  /**
   * The Mac applied `revision` and put the cursor at `position`.
   *
   * Returns the position only once the Mac has caught up with every guess. An older
   * acknowledgement clears the work it covers but never pulls the drawn cursor back to where it
   * was before the newer guesses, which would make it stutter backwards on every frame.
   */
  applyHostApplied(revision: number, position: CursorPoint, now: number): CursorPoint | null {
    if (revision <= this.lastAppliedRevision || revision >= this.nextRevision) return null;
    this.lastAppliedRevision = revision;
    this.pending = this.pending.filter((entry) => entry.revision > revision);
    this.updateConfidence(now);
    return this.pending.length === 0 ? position : null;
  }

  /**
   * The Mac's cursor moved by something other than this viewer: a real mouse, another viewer.
   *
   * That position is the new base, and every guess the Mac had not yet applied is replayed on top
   * of it, so newer finger travel is kept rather than thrown away.
   */
  applyHostMoved(position: CursorPoint, clamp: CursorClamp, now: number): CursorPoint {
    const replayed = this.pending.reduce(
      (point, entry) => applyOperation(entry.operation, point, clamp),
      clamp(position),
    );
    this.updateConfidence(now);
    return replayed;
  }

  /** A send failed: the guess will never be confirmed, so say so at once. */
  markSendFailed(revision: number): void {
    if (!this.pending.some((entry) => entry.revision === revision)) return;
    this.state = "ghost";
  }

  advance(now: number): void {
    this.updateConfidence(now);
  }

  reset(): void {
    this.nextRevision = 1;
    this.lastAppliedRevision = 0;
    this.pending = [];
    this.state = "confirmed";
  }

  /** A ghost recovers only when the Mac has caught up, never by a deadline passing. */
  private updateConfidence(now: number): void {
    const deadline = this.ghostDeadline;
    if (deadline === null) {
      this.state = "confirmed";
      return;
    }
    if (this.state === "ghost") return;
    this.state = now >= deadline ? "ghost" : "awaiting-host";
  }
}

function applyOperation(operation: CursorOperation, point: CursorPoint, clamp: CursorClamp): CursorPoint {
  return operation.kind === "set"
    ? clamp(operation.to)
    : clamp({ x: point.x + operation.dx, y: point.y + operation.dy });
}
