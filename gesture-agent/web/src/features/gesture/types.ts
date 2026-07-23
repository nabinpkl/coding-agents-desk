import type { Category, NormalizedLandmark } from "@mediapipe/tasks-vision";

/**
 * Run state for the gesture tracking loop, modelled as a discriminated union so
 * views switch on `status` instead of juggling loose booleans.
 */
export type GestureRunState =
  | { status: "idle" }
  | { status: "requestingCamera" }
  | { status: "tracking" }
  | { status: "error"; message: string };

/**
 * Latest client-side inference output for a single processed video frame. This
 * is momentum: it is overwritten every animation frame and never persisted.
 */
export interface GestureFrame {
  /** One entry per detected hand, each a list of 21 normalized landmarks. */
  hands: NormalizedLandmark[][];
  /** Handedness classification aligned by index with `hands`. */
  handedness: Category[][];
  /** One entry per detected face, each a list of 478 normalized landmarks. */
  faces: NormalizedLandmark[][];
}

/** Intrinsic pixel size of the source video, needed to size the overlay canvas. */
export interface VideoSize {
  width: number;
  height: number;
}

/**
 * Anchor center + elliptical "near" region, in mirrored (user-perspective)
 * normalized coordinates. A frontend-only shape: since the tracker runs
 * client-side, this is computed locally for the anchor-ellipse overlay and no
 * longer crosses any wire.
 */
export interface GestureAnchor {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  /** True while the hand sits inside the near region. */
  near: boolean;
}

export const EMPTY_GESTURE_FRAME: GestureFrame = {
  hands: [],
  handedness: [],
  faces: [],
};
