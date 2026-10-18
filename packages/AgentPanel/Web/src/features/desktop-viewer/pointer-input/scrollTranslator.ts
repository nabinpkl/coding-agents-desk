// The scroll half of the gesture translator: a finger's scroll, its coast, and the wheel.
//
// `GestureTranslator.processScrollPan` and its momentum tail in the Swift, split from the
// pointer half only because the two together outgrew one file. They share one `emit`, so a
// refused scroll marks the same gesture refused as a refused move would.

import type { DesktopScrollPhase } from "@agentdesk/agent-feed-wire";
import {
  SCROLL_AXIS_DOMINANCE_RATIO,
  SCROLL_AXIS_SLOP,
  SCROLL_MOMENTUM_DECAY_K,
  SCROLL_MOMENTUM_FLICK_THRESHOLD,
  SCROLL_MOMENTUM_STOP_THRESHOLD,
  scrollAccelerationGain,
} from "@/features/desktop-viewer/pointer-input/gestureConstants";
import type {
  GestureOutput,
  GestureTranslatorOptions,
  Point,
} from "@/features/desktop-viewer/pointer-input/gestureTranslator";
import { DEFAULT_GESTURE_TUNING, type GestureTuning } from "@/features/desktop-viewer/pointer-input/gestureTuning";
import { STILL, type Velocity } from "@/features/desktop-viewer/pointer-input/velocityTracker";

/**
 * How a scroll treats its two axes.
 *
 * The strip commits to one: it is a narrow clutch grabbed on purpose, the axis meant is obvious
 * from the first inch, and locking stops a vertical drag smearing content sideways. A finger on
 * the content itself is the opposite case and scrolls both at once, as a real trackpad does.
 */
export type ScrollAxisPolicy = "dominant-axis" | "free";
type ScrollAxis = "undecided" | "horizontal" | "vertical" | "free";

export class ScrollTranslator {
  private readonly emit: (output: GestureOutput) => boolean;
  private readonly frames: GestureTranslatorOptions["frames"];
  private readonly now: () => number;
  private readonly tuning: () => GestureTuning;
  private readonly gain: (speed: number) => number;

  private lastScrollTranslation: Point = { x: 0, y: 0 };
  private scrollStartTranslation: Point = { x: 0, y: 0 };
  private lastScrollVelocity: Velocity = STILL;
  private scrollAxis: ScrollAxis = "undecided";
  private didEmitScrollBegan = false;
  private momentumFrame = 0;
  private momentumVelocity: Velocity = STILL;
  private momentumLastTime = 0;
  private didEmitMomentumBegan = false;

  constructor(options: GestureTranslatorOptions) {
    this.emit = options.emit;
    this.frames = options.frames;
    this.now = options.now;
    this.tuning = options.tuning ?? (() => DEFAULT_GESTURE_TUNING);
    this.gain = options.scrollGain ?? scrollAccelerationGain;
  }

  /** Whether the Mac has a scroll phase open. */
  get isScrolling(): boolean {
    return this.didEmitScrollBegan;
  }

  get isCoasting(): boolean {
    return this.momentumFrame !== 0;
  }

  /** A scroll gesture began. Touching stops any coast still running, as a Mac trackpad does. */
  begin(translation: Point = { x: 0, y: 0 }, policy: ScrollAxisPolicy = "dominant-axis"): void {
    this.stopMomentum(true);
    this.lastScrollTranslation = translation;
    this.scrollStartTranslation = translation;
    this.lastScrollVelocity = STILL;
    this.scrollAxis = policy === "free" ? "free" : "undecided";
    this.didEmitScrollBegan = false;
  }

  /**
   * The finger is at `translation` from where the gesture began, moving at `velocity`.
   *
   * The first emission is `began`, every one after it `changed`. Under the dominant-axis policy
   * nothing goes out until the finger has travelled far enough for one axis to win.
   */
  change(translation: Point, velocity: Velocity): void {
    if (this.scrollAxis === "undecided") {
      const locked = this.lockedScrollAxis(translation);
      if (!locked) return;
      this.scrollAxis = locked;
    }
    const raw = {
      x: translation.x - this.lastScrollTranslation.x,
      y: translation.y - this.lastScrollTranslation.y,
    };
    this.lastScrollTranslation = translation;
    const projected = this.projectedVelocity(velocity);
    if (projected.x !== 0 || projected.y !== 0) this.lastScrollVelocity = projected;
    const delta = this.projectedDelta(raw, projected);
    if (delta.x === 0 && delta.y === 0) return;
    const phase: DesktopScrollPhase = this.didEmitScrollBegan ? "changed" : "began";
    this.didEmitScrollBegan = true;
    this.emit({ type: "scroll", dx: delta.x, dy: delta.y, phase });
  }

  /**
   * The finger lifted. Ends the Mac's scroll phase, then coasts if it was thrown.
   *
   * The coast is seeded from the last velocity seen while moving rather than from `velocity`,
   * which is the estimate at lift and, like UIKit's, unreliable there. `allowMomentum` false is a
   * lift that should not coast at all, such as a finger that never really scrolled.
   */
  end(velocity: Velocity = STILL, allowMomentum = true): void {
    this.lastScrollTranslation = { x: 0, y: 0 };
    this.scrollStartTranslation = { x: 0, y: 0 };
    // Ended even with no movement in between, or macOS folds the next gesture into this one.
    if (this.didEmitScrollBegan) this.emit({ type: "scroll", dx: 0, dy: 0, phase: "ended" });
    this.didEmitScrollBegan = false;
    const fallback = this.projectedVelocity(velocity);
    const lift =
      this.lastScrollVelocity.x !== 0 || this.lastScrollVelocity.y !== 0 ? this.lastScrollVelocity : fallback;
    if (allowMomentum && Math.hypot(lift.x, lift.y) >= SCROLL_MOMENTUM_FLICK_THRESHOLD) {
      this.startMomentum(lift);
    }
    this.lastScrollVelocity = STILL;
    this.scrollAxis = "undecided";
  }

  /** The gesture was taken away: close the phase, and do not coast. */
  cancel(): void {
    this.lastScrollTranslation = { x: 0, y: 0 };
    this.scrollStartTranslation = { x: 0, y: 0 };
    if (this.didEmitScrollBegan) this.emit({ type: "scroll", dx: 0, dy: 0, phase: "ended" });
    this.didEmitScrollBegan = false;
    this.lastScrollVelocity = STILL;
    this.scrollAxis = "undecided";
  }

  /**
   * A scroll the OS already decided on, as a wheel or a Mac trackpad reports it.
   *
   * It goes out as it is: macOS's own curve is already in the delta, and pushing it through the
   * finger curve read five wheel notches as a flick. It shares the finger's phase, so a wheel and
   * a finger cannot both have a phase open.
   */
  wheelScroll(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (!this.didEmitScrollBegan) this.stopMomentum(true);
    const phase: DesktopScrollPhase = this.didEmitScrollBegan ? "changed" : "began";
    this.didEmitScrollBegan = true;
    this.emit({ type: "scroll", dx, dy, phase });
  }

  /** A wheel has no lift; its caller decides from silence that the hand is off. */
  wheelEnd(): void {
    if (this.didEmitScrollBegan) this.emit({ type: "scroll", dx: 0, dy: 0, phase: "ended" });
    this.didEmitScrollBegan = false;
  }

  private lockedScrollAxis(translation: Point): ScrollAxis | null {
    const dx = translation.x - this.scrollStartTranslation.x;
    const dy = translation.y - this.scrollStartTranslation.y;
    if (Math.hypot(dx, dy) < SCROLL_AXIS_SLOP) return null;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX > absY * SCROLL_AXIS_DOMINANCE_RATIO) return "horizontal";
    if (absY > absX * SCROLL_AXIS_DOMINANCE_RATIO) return "vertical";
    return null;
  }

  private projectedVelocity(velocity: Velocity): Velocity {
    switch (this.scrollAxis) {
      case "horizontal":
        return { x: velocity.x, y: 0 };
      case "vertical":
        return { x: 0, y: velocity.y };
      case "free":
        return velocity;
      case "undecided":
        return STILL;
    }
  }

  /**
   * The direction preference applies to both axes, and its sign is calibrated to what this Mac
   * delivers rather than what is posted: a third-party input tap (LinearMouse) reverses scroll
   * before any app sees it. "Natural" off is +1. See `projectedScrollDelta` in the Swift.
   */
  private projectedDelta(delta: Point, velocity: Velocity): Point {
    const tuning = this.tuning();
    const gain = this.gain(Math.hypot(velocity.x, velocity.y)) * tuning.scrollSpeed;
    const sign = tuning.naturalScrolling ? -1 : 1;
    switch (this.scrollAxis) {
      case "horizontal":
        return { x: delta.x * gain * sign, y: 0 };
      case "vertical":
        return { x: 0, y: delta.y * gain * sign };
      case "free":
        return { x: delta.x * gain * sign, y: delta.y * gain * sign };
      case "undecided":
        return { x: 0, y: 0 };
    }
  }

  private startMomentum(velocity: Velocity): void {
    this.stopMomentum(false);
    this.momentumVelocity = velocity;
    this.momentumLastTime = this.now();
    this.didEmitMomentumBegan = false;
    this.momentumFrame = this.frames.request((now) => this.momentumTick(now));
  }

  /** Stops a coast. `emitEnd` closes the Mac's momentum phase if one was opened. */
  stopMomentum(emitEnd: boolean): void {
    const wasRunning = this.momentumFrame !== 0;
    if (this.momentumFrame !== 0) this.frames.cancel(this.momentumFrame);
    this.momentumFrame = 0;
    this.momentumVelocity = STILL;
    if (emitEnd && wasRunning && this.didEmitMomentumBegan) {
      this.emit({ type: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });
    }
    this.didEmitMomentumBegan = false;
  }

  /** One frame of the coast: v *= e^(-k dt), stopping below the threshold. */
  momentumTick(now: number): void {
    this.momentumFrame = 0;
    const elapsed = Math.max((now - this.momentumLastTime) / 1_000, 0);
    this.momentumLastTime = now;
    const decay = Math.exp(-SCROLL_MOMENTUM_DECAY_K * elapsed);
    this.momentumVelocity = { x: this.momentumVelocity.x * decay, y: this.momentumVelocity.y * decay };
    const speed = Math.hypot(this.momentumVelocity.x, this.momentumVelocity.y);
    if (speed < SCROLL_MOMENTUM_STOP_THRESHOLD) {
      if (this.didEmitMomentumBegan) this.emit({ type: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });
      this.didEmitMomentumBegan = false;
      this.momentumVelocity = STILL;
      return;
    }
    const tuning = this.tuning();
    const gain = this.gain(speed) * tuning.scrollSpeed;
    // Signed as the drag was, or a flick coasts back against the direction that threw it.
    const sign = tuning.naturalScrolling ? -1 : 1;
    const phase: DesktopScrollPhase = this.didEmitMomentumBegan ? "momentumChanged" : "momentumBegan";
    this.didEmitMomentumBegan = true;
    this.emit({
      type: "scroll",
      dx: this.momentumVelocity.x * elapsed * gain * sign,
      dy: this.momentumVelocity.y * elapsed * gain * sign,
      phase,
    });
    this.momentumFrame = this.frames.request((next) => this.momentumTick(next));
  }
}
