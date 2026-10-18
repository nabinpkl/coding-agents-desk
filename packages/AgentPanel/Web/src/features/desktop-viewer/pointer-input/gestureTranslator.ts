// What a finger means to the Mac: the TypeScript twin of the iPhone client's GestureTranslator.
//
// `client/AgentDeskClient/GestureTranslator.swift` was tuned on a device: when a move starts,
// how speed becomes distance, which axis a scroll commits to, how a flick coasts and stops, how
// a held drag keeps going at the edge. This is that state machine with the UIKit taken out, so
// the picture, the trackpad and the scroll strip all drive the same one and a finger means the
// same thing wherever it lands. Like the Swift `process*` seams, every entry point takes the
// gesture's state as arguments and the clock and the frame loop are injected, so a test can replay
// a gesture without a browser.
//
// It says nothing about where a gesture came from. Callers turn pointer events into `cursor*`,
// `scroll.*`, `drag*` and `tap` calls; this turns those into what the wire carries.

import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import {
  DRAG_EDGE_MAXIMUM_SPEED,
  DRAG_EDGE_MINIMUM_SPEED,
  DRAG_EDGE_THRESHOLD,
  POINTER_SLOP,
  pointerAccelerationGain,
} from "@/features/desktop-viewer/pointer-input/gestureConstants";
import { DEFAULT_GESTURE_TUNING, type GestureTuning } from "@/features/desktop-viewer/pointer-input/gestureTuning";
import { ScrollTranslator } from "@/features/desktop-viewer/pointer-input/scrollTranslator";

/**
 * What the translator produces: the wire's pointer inputs, except that a relative move is left
 * unnumbered. Numbering it is the cursor model's job, because the number is what reconciles the
 * drawn cursor with the Mac's (`remoteCursor.ts`).
 */
export type GestureOutput =
  | Exclude<DesktopPointerInput, { type: "pointer-move" | "pointer-warp" }>
  | { type: "cursor-move"; dx: number; dy: number };

/** A frame loop: `requestAnimationFrame` in the browser, a queue in a test. */
export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

export interface Point {
  x: number;
  y: number;
}

/** The surface a drag runs on, for the edge auto-pan. Origin at 0,0. */
export interface DragBounds {
  width: number;
  height: number;
}

export interface GestureTranslatorOptions {
  /** Delivers one output; false means the transport refused it. */
  emit: (output: GestureOutput) => boolean;
  frames: FrameScheduler;
  /** Milliseconds. */
  now: () => number;
  tuning?: () => GestureTuning;
  /**
   * The speed-to-gain curves, the shipped ones unless a test asks for none. The Swift
   * translator takes the same two (`GestureAcceleration`), defaulting to identity, which is what
   * its tests ran against and what lets their vectors be replayed here unchanged.
   */
  pointerGain?: (speed: number) => number;
  scrollGain?: (speed: number) => number;
}

/** No acceleration: travel in is travel out. */
export const IDENTITY_GAIN = () => 1;

export class GestureTranslator {
  private readonly emitOutput: (output: GestureOutput) => boolean;
  private readonly frames: FrameScheduler;
  private readonly now: () => number;
  private readonly tuning: () => GestureTuning;
  private readonly pointerGain: (speed: number) => number;
  /** False once any output of the current gesture was refused; read and reset by the caller. */
  accepted = true;
  /** The scroll half: the strip, the puck, the wheel. One instance, so one phase and one coast. */
  readonly scroll: ScrollTranslator;

  // --- cursor: CoalescingTrackpadGestureRecognizer + emitCursorDelta ---
  private cursorStart: Point | null = null;
  private cursorLast: Point | null = null;
  private cursorCrossedSlop = false;
  private pendingDx = 0;
  private pendingDy = 0;
  private cursorFrame = 0;
  private lastCursorTick = 0;

  // --- drag: processDrag and the edge auto-pan ---
  private dragging = false;
  private dragLastPoint: Point = { x: 0, y: 0 };
  private dragLastTime = 0;
  private dragEdgeDirection: Point = { x: 0, y: 0 };
  private dragEdgeSpeed = 0;
  private dragEdgeActive = false;
  private dragEdgeFrame = 0;
  private dragEdgeLastTime = 0;

  constructor(options: GestureTranslatorOptions) {
    this.emitOutput = options.emit;
    this.frames = options.frames;
    this.now = options.now;
    this.tuning = options.tuning ?? (() => DEFAULT_GESTURE_TUNING);
    this.pointerGain = options.pointerGain ?? pointerAccelerationGain;
    this.scroll = new ScrollTranslator({ ...options, emit: (output) => this.emit(output) });
  }

  private emit(output: GestureOutput): boolean {
    const accepted = this.emitOutput(output);
    this.accepted = accepted && this.accepted;
    return accepted;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  // ---------------------------------------------------------------------------------------------
  // Cursor

  /** A finger landed for the pointer. Nothing moves until it crosses the slop. */
  cursorBegin(at: Point, now = this.now()): void {
    this.cancelCursorFrame();
    this.cursorStart = at;
    this.cursorLast = at;
    this.cursorCrossedSlop = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.lastCursorTick = now;
  }

  /**
   * Every position the finger reported since the last call, oldest first.
   *
   * Summed into one frame's travel and sent once per frame with the speed of that whole frame,
   * which is what keeps the acceleration curve from being whipsawed by uneven sample spacing.
   * Travel inside the slop is dropped, measured from touch-down. Returns whether the finger has
   * crossed it, which is what tells a caller the touch is a move and not a tap.
   */
  cursorSamples(samples: readonly Point[]): boolean {
    const start = this.cursorStart;
    if (!start) return false;
    for (const sample of samples) {
      if (!this.cursorCrossedSlop) {
        if (Math.hypot(sample.x - start.x, sample.y - start.y) < POINTER_SLOP) {
          this.cursorLast = sample;
          continue;
        }
        this.cursorCrossedSlop = true;
      }
      if (this.cursorLast) {
        this.pendingDx += sample.x - this.cursorLast.x;
        this.pendingDy += sample.y - this.cursorLast.y;
      }
      this.cursorLast = sample;
    }
    if ((this.pendingDx !== 0 || this.pendingDy !== 0) && this.cursorFrame === 0) {
      this.cursorFrame = this.frames.request((now) => {
        this.cursorFrame = 0;
        this.flushCursor(now);
      });
    }
    return this.cursorCrossedSlop;
  }

  get cursorMoved(): boolean {
    return this.cursorCrossedSlop;
  }

  /** The finger lifted: what arrived since the last frame still goes, so a flick keeps its tail. */
  cursorEnd(now = this.now()): void {
    this.cancelCursorFrame();
    this.flushCursor(now);
    this.cursorStart = null;
    this.cursorLast = null;
  }

  /** A second finger or a cancel: the travel since the last frame is not the pointer's any more. */
  cursorCancel(): void {
    this.cancelCursorFrame();
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.cursorStart = null;
    this.cursorLast = null;
  }

  private cancelCursorFrame(): void {
    if (this.cursorFrame !== 0) this.frames.cancel(this.cursorFrame);
    this.cursorFrame = 0;
  }

  private flushCursor(now: number): void {
    const elapsed = Math.max((now - this.lastCursorTick) / 1_000, 0.001);
    this.lastCursorTick = now;
    if (this.pendingDx === 0 && this.pendingDy === 0) return;
    const dx = this.pendingDx;
    const dy = this.pendingDy;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.emitCursorDelta(dx, dy, Math.hypot(dx, dy) / elapsed);
  }

  /**
   * The trackpad's pointer motion. Muted while a held drag is running, because the drag is then
   * the only thing moving the pointer and both would otherwise send the same travel.
   */
  private emitCursorDelta(dx: number, dy: number, speed: number): void {
    if (this.dragging) return;
    const tuning = this.tuning();
    const gain = this.pointerGain(speed) * tuning.cursorAcceleration;
    this.emit({ type: "cursor-move", dx: dx * gain * tuning.cursorSpeed, dy: dy * gain * tuning.cursorSpeed });
  }

  // ---------------------------------------------------------------------------------------------
  // Tap

  /** A click where the pointer is. Consecutive taps become a double click on the Mac's side. */
  tap(button: "left" | "right" = "left", focusRequestId?: string): boolean {
    return this.emit({ type: "click", button, ...(focusRequestId ? { focusRequestId } : {}) });
  }

  // ---------------------------------------------------------------------------------------------
  // Drag

  /**
   * A held finger pressed the button. From here until `dragEnd` the finger's travel moves the
   * pointer 1:1 (times the tuning), with no acceleration: a drag is usually a text selection or a
   * careful placement, and a curve would overshoot it. Returns false when the press was refused,
   * in which case nothing is held.
   */
  dragBegin(at: Point, now = this.now()): boolean {
    this.stopDragEdgePan();
    this.dragEdgeDirection = { x: 0, y: 0 };
    this.dragEdgeSpeed = 0;
    if (!this.emit({ type: "mouse-down", button: "left" })) return false;
    this.dragging = true;
    this.dragLastPoint = at;
    this.dragLastTime = now;
    return true;
  }

  dragMove(at: Point, bounds: DragBounds, now = this.now()): void {
    if (!this.dragging) return;
    const dx = at.x - this.dragLastPoint.x;
    const dy = at.y - this.dragLastPoint.y;
    const elapsed = Math.max((now - this.dragLastTime) / 1_000, 0.001);
    this.dragLastPoint = at;
    this.dragLastTime = now;
    if (dx === 0 && dy === 0) return;
    const tuning = this.tuning();
    const gain = tuning.cursorAcceleration * tuning.cursorSpeed;
    this.emit({ type: "cursor-move", dx: dx * gain, dy: dy * gain });
    this.updateDragEdgePan(at, { x: dx, y: dy }, elapsed, bounds, now);
  }

  /** Lets go. Returns whether a button was actually held, which is what suppresses the tap. */
  dragEnd(): boolean {
    this.dragLastPoint = { x: 0, y: 0 };
    this.dragLastTime = 0;
    if (!this.dragging) return false;
    this.dragging = false;
    this.stopDragEdgePan();
    this.emit({ type: "mouse-up", button: "left" });
    return true;
  }

  /** One frame of the edge auto-pan: keep moving the way the finger was going when it hit the edge. */
  dragEdgeTick(now: number): void {
    this.dragEdgeFrame = 0;
    if (!this.dragging || !this.dragEdgeActive) return;
    if (this.dragEdgeDirection.x === 0 && this.dragEdgeDirection.y === 0) return;
    const elapsed = Math.max((now - this.dragEdgeLastTime) / 1_000, 0.001);
    this.dragEdgeLastTime = now;
    const tuning = this.tuning();
    const gain = tuning.cursorAcceleration * tuning.cursorSpeed;
    this.emit({
      type: "cursor-move",
      dx: this.dragEdgeDirection.x * this.dragEdgeSpeed * elapsed * gain,
      dy: this.dragEdgeDirection.y * this.dragEdgeSpeed * elapsed * gain,
    });
    this.dragEdgeFrame = this.frames.request((next) => this.dragEdgeTick(next));
  }

  private updateDragEdgePan(at: Point, delta: Point, elapsed: number, bounds: DragBounds, now: number): void {
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.stopDragEdgePan();
      return;
    }
    const edge = nearestDragEdge(at, bounds);
    if (!edge) {
      this.stopDragEdgePan();
      return;
    }
    if (!movingOutward(edge, delta)) {
      if (this.dragEdgeActive) this.stopDragEdgePan();
      return;
    }
    const magnitude = Math.hypot(delta.x, delta.y);
    this.dragEdgeSpeed = Math.min(Math.max(magnitude / elapsed, DRAG_EDGE_MINIMUM_SPEED), DRAG_EDGE_MAXIMUM_SPEED);
    this.dragEdgeDirection = { x: delta.x / magnitude, y: delta.y / magnitude };
    if (!this.dragEdgeActive) {
      this.dragEdgeActive = true;
      this.dragEdgeLastTime = now;
      this.dragEdgeFrame = this.frames.request((next) => this.dragEdgeTick(next));
    }
  }

  private stopDragEdgePan(): void {
    this.dragEdgeActive = false;
    this.dragEdgeDirection = { x: 0, y: 0 };
    this.dragEdgeSpeed = 0;
    if (this.dragEdgeFrame !== 0) this.frames.cancel(this.dragEdgeFrame);
    this.dragEdgeFrame = 0;
  }

  /** Everything off, as a surface going away needs: no frame left running, no button left down. */
  dispose(): void {
    this.cursorCancel();
    this.scroll.cancel();
    this.scroll.stopMomentum(true);
    this.dragEnd();
  }
}

type DragEdge = "left" | "right" | "top" | "bottom";

function nearestDragEdge(at: Point, bounds: DragBounds): DragEdge | null {
  const left = at.x;
  const right = bounds.width - at.x;
  const top = at.y;
  const bottom = bounds.height - at.y;
  const nearest = Math.min(left, right, top, bottom);
  if (nearest > DRAG_EDGE_THRESHOLD) return null;
  if (nearest === left) return "left";
  if (nearest === right) return "right";
  if (nearest === top) return "top";
  return "bottom";
}

function movingOutward(edge: DragEdge, delta: Point): boolean {
  switch (edge) {
    case "left":
      return delta.x < 0;
    case "right":
      return delta.x > 0;
    case "top":
      return delta.y < 0;
    case "bottom":
      return delta.y > 0;
  }
}
