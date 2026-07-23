/**
 * Types for the client-side swipe tracker. Faithful port of the value objects
 * in `src/interaction_agent/gesture/action/tracker.py`. Kept structurally
 * identical to the Python so the golden-vector equivalence test stays honest.
 */

/** One normalized (x, y) landmark. */
export type Point = readonly [number, number];

/** A full hand: 21 landmarks the tracker indexes by MediaPipe order. */
export type PatternFrame = readonly Point[];

export type ActionLabel = "LEFT SWIPE" | "RIGHT SWIPE";
export type AnchorPhase =
  | "NO_ANCHOR"
  | "NO_HAND"
  | "READY"
  | "ARMED"
  | "WAIT_RETURN";
export type AnchorRegion = "near" | "left_trigger" | "right_trigger" | "away";

export interface RelativeHandPosition {
  readonly dx: number;
  readonly dy: number;
  readonly region: AnchorRegion;
}

export interface AnchorSnapshot {
  readonly center: Point;
  readonly scale: number;
  readonly width: number;
  readonly aspect: number;
  readonly enablesOpenPalmRightTrigger: boolean;
  readonly createdAt: number;
}

export interface MotionSample {
  readonly createdAt: number;
  readonly position: RelativeHandPosition;
}

/** A committed swipe. Mirrors the Python `ActionEvent` (with `position`). */
export interface ActionEvent {
  readonly label: ActionLabel;
  readonly position: RelativeHandPosition;
  readonly confidence: number;
  readonly createdAt: number;
}
