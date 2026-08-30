// Desktop park wire shapes. Types only, long keys, no runtime exports (README.md).
//
// One definition for both sides: the sidecar builds these and the panel reads
// them. A second hand-kept copy in the panel is exactly how the agent-feed keys
// drifted before.

/** A rectangle in global display coordinates, top-down. */
export interface ParkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParkSpaceRef {
  index: number;
  id: number;
  display: number;
}

export interface ParkWindow {
  id: number;
  app: string;
  title: string;
  pid: number;
  space: number;
  display: number;
  frame: ParkRect;
  onActiveSpace: boolean;
  isVisible: boolean;
}

export interface ParkStateResponse {
  /** Null when this machine has no yabai, which is what makes the feature unavailable. */
  yabaiPath: string | null;
  activeSpace: ParkSpaceRef;
  displays: { index: number; frame: ParkRect }[];
  /** Front-to-back, as yabai reports it. The ladder's only hard input. */
  stackingOrder: number[];
  counts: {
    tracked: number;
    parkable: number;
    alreadyHere: number;
    elsewhere: number;
  };
  windows: ParkWindow[];
}

/** Relative pointer-mode input carried beside a WebRTC tile's video track. */
export type WebrtcPointerInput =
  | { t: "move"; dx: number; dy: number }
  | { t: "click"; button: "left" | "right" }
  | {
      t: "scroll";
      dx: number;
      dy: number;
      phase:
        | "began"
        | "changed"
        | "ended"
        | "momentumBegan"
        | "momentumChanged"
        | "momentumEnded";
    };

export type ParkSide = "left" | "right";

export interface ParkMove {
  id: number;
  app: string;
  title: string;
  side: ParkSide;
  /** Position in the stacking order the plan was computed against. 0 is frontmost. */
  depth: number;
  rung: number;
  from: { space: number; x: number; y: number };
  to: { space: number; x: number; y: number };
  /**
   * Square points of this window that nothing in front of it would cover.
   * Zero means it would stop rendering, which makes the plan unsound.
   */
  exposedPt2: number;
  noop: boolean;
}

export interface ParkPlanResponse {
  activeSpace: ParkSpaceRef;
  display: { index: number; frame: ParkRect };
  options: { strip: number; step: number; topMargin: number };
  sound: boolean;
  /** Windows with no vertical room left. Never moved. */
  overflow: number[];
  /** Windows the plan would starve. Non-empty means the plan is wrong, not tight. */
  starved: number[];
  moves: ParkMove[];
}

export interface ParkStepResult {
  id: number;
  app: string;
  ok: boolean;
  detail?: string;
}

export interface ParkReport {
  targetSpace: { index: number; uuid: string };
  candidates: number;
  gathered: ParkStepResult[];
  /** The order the windows settled into after the gather, which the ladder used. */
  observedOrder: number[];
  /** The order before the gather, kept so the difference is visible. */
  orderBeforeGather: number[];
  laid: ParkStepResult[];
  sound: boolean;
  manifestPath: string | null;
  dryRun: boolean;
}

export type ParkRestoreOutcome = "restored" | "orphaned" | "moved-by-user" | "failed";

export interface ParkRestoreResult {
  windowID: number;
  app: string;
  outcome: ParkRestoreOutcome;
  detail?: string;
}

export interface ParkRestoreReport {
  found: boolean;
  parkedAt: number | null;
  results: ParkRestoreResult[];
  manifestCleared: boolean;
}

export interface ParkUnavailable {
  code: "park-unavailable" | "park-unconfirmed";
  message: string;
  yabaiPath?: string | null;
}
