// Every number a finger's input to the Mac is tuned against.
//
// Each one is the iPhone client's (`client/AgentDeskClient/`), which was tuned on a device, and
// names the Swift symbol it came from. `swiftParity.test.ts` reads those symbols out of the Swift
// source and fails when the two disagree, so retuning one side without the other is loud. The
// view's own numbers (zoom, settle, the puck's look) are the tile's and stay in
// `tileViewportConstants.ts`.

/** Travel from touch-down before a finger moves the pointer. `CoalescingTrackpadGestureRecognizer.slopThreshold`. */
export const POINTER_SLOP = 3;
/**
 * Travel before a finger on the picture becomes a scroll under the puck, or before the puck itself
 * moves. UIKit's standard pan slop, which the puck and pointer-scroll recognizers use; it is not a
 * number our Swift states, so it has no parity check.
 */
export const SCROLL_SLOP = 10;

/** `GestureAcceleration.mac`: 1.5 + min(v * 0.005, 8.5), v in points per second. */
export const POINTER_ACCELERATION_FLOOR = 1.5;
export const POINTER_ACCELERATION_SLOPE = 0.005;
export const POINTER_ACCELERATION_CEILING = 8.5;
/** `GestureAcceleration.scroll`: 1 + min(v * 0.0045, 11). */
export const SCROLL_ACCELERATION_FLOOR = 1;
export const SCROLL_ACCELERATION_SLOPE = 0.0045;
export const SCROLL_ACCELERATION_CEILING = 11;

/** `GestureTranslator.scrollAxisSlop`: travel before the strip commits to an axis. */
export const SCROLL_AXIS_SLOP = 12;
/** `GestureTranslator.scrollAxisDominanceRatio`: how much bigger the winning axis must be. */
export const SCROLL_AXIS_DOMINANCE_RATIO = 1.25;
/** `GestureTranslator.momentumFlickThreshold`: slower lifts end without a coast. */
export const SCROLL_MOMENTUM_FLICK_THRESHOLD = 200;
/** `GestureTranslator.momentumStopThreshold`: the coast ends below this speed. */
export const SCROLL_MOMENTUM_STOP_THRESHOLD = 30;
/** `GestureTranslator.momentumDecayK`: v(t) = v0 * e^(-k t). */
export const SCROLL_MOMENTUM_DECAY_K = 2.8;

/**
 * How long one finger stays still before it becomes a held button.
 * `UILongPressGestureRecognizer.minimumPressDuration` in `GestureTranslator.attach`, 0.25s.
 */
export const TOUCH_DRAG_HOLD_MS = 250;
/** `GestureTranslator.dragEdgeThreshold`: how near an edge a dragging finger starts the auto-pan. */
export const DRAG_EDGE_THRESHOLD = 44;
/** `GestureTranslator.dragEdgeMinimumSpeed` / `dragEdgeMaximumSpeed`, points per second. */
export const DRAG_EDGE_MINIMUM_SPEED = 180;
export const DRAG_EDGE_MAXIMUM_SPEED = 1400;

/**
 * How far back the velocity estimate looks.
 *
 * Ours, not Swift's: UIKit hands its recognizers a smoothed velocity and never says how, and a
 * browser hands us positions. One raw sample's dx/dt is what the web used before, and a single
 * jittery sample at lift then decided the whole coast. A tenth of a second is long enough to
 * average that out and short enough that a flick which slowed before lifting reads as slow.
 */
export const VELOCITY_WINDOW_MS = 100;

/** Pointer gain for a finger speed in points per second. */
export function pointerAccelerationGain(speed: number): number {
  return (
    POINTER_ACCELERATION_FLOOR + Math.min(Math.max(0, speed) * POINTER_ACCELERATION_SLOPE, POINTER_ACCELERATION_CEILING)
  );
}

/** Scroll gain for a finger speed in points per second. */
export function scrollAccelerationGain(speed: number): number {
  return (
    SCROLL_ACCELERATION_FLOOR + Math.min(Math.max(0, speed) * SCROLL_ACCELERATION_SLOPE, SCROLL_ACCELERATION_CEILING)
  );
}
