/**
 * Client-side swipe detector. Faithful port of
 * `src/interaction_agent/gesture/action/tracker.py`.
 *
 * Same 5-state machine, same tuned constants, same six trigger paths. Runs in
 * the webview so gesture needs no backend. Determinism is the contract: given
 * the same (frame, now) sequence it must produce byte-identical `ActionEvent`s
 * to the Python tracker — the golden-vector test enforces this. Keep the
 * translation literal; do not "improve" the logic here.
 */

import { patternHandScale, patternPalmCenter } from "./patterns";
import type {
  ActionEvent,
  ActionLabel,
  AnchorPhase,
  AnchorRegion,
  AnchorSnapshot,
  MotionSample,
  PatternFrame,
  Point,
  RelativeHandPosition,
} from "./types";

const ACTION_DISPLAY_SECONDS = 1.0;
const ACTION_COOLDOWN_SECONDS = 0.35;
const ANCHOR_NEAR_HORIZONTAL_RADIUS = 0.22;
const ANCHOR_NEAR_VERTICAL_RADIUS = 0.55;
const LEFT_TRIGGER_DX = -0.55;
const LEFT_TRIGGER_MIN_DY = 0.1;
const LEFT_LOCAL_MOTION_SECONDS = 0.65;
const LEFT_LOCAL_TRIGGER_DX = -0.2;
const LEFT_LOCAL_TRIGGER_DY = 0.08;
const LEFT_LOCAL_TRIGGER_MAX_POSITION_DX = -0.14;
const LEFT_LOCAL_TRIGGER_MIN_START_DX = -0.05;
const LEFT_SHAPE_TRIGGER_DX = -0.12;
const LEFT_SHAPE_TRIGGER_DY = 0.03;
const LEFT_SHAPE_TRIGGER_MAX_POSITION_DX = -0.12;
const LEFT_SHAPE_TRIGGER_MIN_START_DX = -0.08;
const LEFT_SHAPE_MIN_WIDTH = 0.17;
const LEFT_SHAPE_MIN_ASPECT = 0.4;
const LEFT_SHAPE_MIN_INDEX_PINKY_DX = 0.25;
const LEFT_FINGER_TIP_INDICES = [8, 12, 16, 20] as const;
const LEFT_FINGER_MIN_INDEX_DX = -0.22;
const LEFT_FINGER_MIN_MIDDLE_DX = -0.4;
const LEFT_FINGER_MIN_RING_DX = -0.45;
const LEFT_FINGER_MIN_PINKY_DX = -0.3;
const LEFT_FINGER_MIN_INDEX_PINKY_DX = 0.25;
const LEFT_FINGER_MAX_ABS_CENTER_DY = 0.08;
const RIGHT_TRIGGER_DX = 0.23;
const RIGHT_OPEN_TRIGGER_MIN_DX = 0.12;
const RIGHT_OPEN_TRIGGER_MAX_ABS_DY = 0.3;
const RIGHT_OPEN_TRIGGER_MIN_WIDTH = 0.23;
const RIGHT_OPEN_TRIGGER_MIN_ASPECT = 0.65;
const RIGHT_OPEN_TRIGGER_MAX_INDEX_PINKY_DX = -0.25;
const RIGHT_FINGER_TIP_INDICES = [8, 12, 16, 20] as const;
const RIGHT_FINGER_MIN_INDEX_DX = 0.22;
const RIGHT_FINGER_MIN_MIDDLE_DX = 0.33;
const RIGHT_FINGER_MIN_RING_DX = 0.4;
const RIGHT_FINGER_MIN_PINKY_DX = 0.38;
const RIGHT_FINGER_MAX_INDEX_PINKY_DX = -0.28;
const RIGHT_FINGER_MAX_CENTER_DX = 0.15;
const RIGHT_FINGER_MAX_ABS_CENTER_DY = 0.08;
const ANCHOR_RETURN_MAX_WIDTH = 0.2;
const ANCHOR_RETURN_MAX_ASPECT = 0.5;

// --- module-level pure helpers (mirror tracker.py's module functions) ------

export function classifyRegion(dx: number, dy: number): AnchorRegion {
  const isNearAnchor =
    Math.abs(dx) <= ANCHOR_NEAR_HORIZONTAL_RADIUS &&
    Math.abs(dy) <= ANCHOR_NEAR_VERTICAL_RADIUS;
  if (isNearAnchor) {
    return "near";
  }
  if (dx <= LEFT_TRIGGER_DX && dy >= LEFT_TRIGGER_MIN_DY) {
    return "left_trigger";
  }
  if (dx >= RIGHT_TRIGGER_DX) {
    return "right_trigger";
  }
  return "away";
}

function handWidthAndAspect(frame: PatternFrame): [number, number] {
  const xs = frame.map((point) => point[0]);
  const ys = frame.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return [width, width / Math.max(height, 0.001)];
}

function isAnchorReturnShape(frame: PatternFrame): boolean {
  const [width, aspect] = handWidthAndAspect(frame);
  return width <= ANCHOR_RETURN_MAX_WIDTH || aspect <= ANCHOR_RETURN_MAX_ASPECT;
}

function isRightOpenTriggerShape(frame: PatternFrame): boolean {
  const [width, aspect] = handWidthAndAspect(frame);
  return (
    width >= RIGHT_OPEN_TRIGGER_MIN_WIDTH &&
    aspect >= RIGHT_OPEN_TRIGGER_MIN_ASPECT &&
    indexPinkyDx(frame) <= RIGHT_OPEN_TRIGGER_MAX_INDEX_PINKY_DX
  );
}

function isLeftOpenTriggerShape(frame: PatternFrame): boolean {
  const [width, aspect] = handWidthAndAspect(frame);
  return (
    width >= LEFT_SHAPE_MIN_WIDTH &&
    aspect >= LEFT_SHAPE_MIN_ASPECT &&
    indexPinkyDx(frame) >= LEFT_SHAPE_MIN_INDEX_PINKY_DX
  );
}

function relativeXFromAnchor(anchor: AnchorSnapshot, point: Point): number {
  const anchorX = anchor.center[0];
  return (point[0] - anchorX) / anchor.scale;
}

function areFingertipsLeftOfAnchor(
  anchor: AnchorSnapshot,
  frame: PatternFrame,
): boolean {
  const [indexDx, middleDx, ringDx, pinkyDx] = LEFT_FINGER_TIP_INDICES.map(
    (tipIndex) => relativeXFromAnchor(anchor, frame[tipIndex]),
  );
  return (
    indexDx <= LEFT_FINGER_MIN_INDEX_DX &&
    middleDx <= LEFT_FINGER_MIN_MIDDLE_DX &&
    ringDx <= LEFT_FINGER_MIN_RING_DX &&
    pinkyDx <= LEFT_FINGER_MIN_PINKY_DX &&
    indexPinkyDx(frame) >= LEFT_FINGER_MIN_INDEX_PINKY_DX
  );
}

function areFingertipsRightOfAnchor(
  anchor: AnchorSnapshot,
  frame: PatternFrame,
): boolean {
  const [indexDx, middleDx, ringDx, pinkyDx] = RIGHT_FINGER_TIP_INDICES.map(
    (tipIndex) => relativeXFromAnchor(anchor, frame[tipIndex]),
  );
  return (
    indexDx >= RIGHT_FINGER_MIN_INDEX_DX &&
    middleDx >= RIGHT_FINGER_MIN_MIDDLE_DX &&
    ringDx >= RIGHT_FINGER_MIN_RING_DX &&
    pinkyDx >= RIGHT_FINGER_MIN_PINKY_DX &&
    indexPinkyDx(frame) <= RIGHT_FINGER_MAX_INDEX_PINKY_DX
  );
}

function indexPinkyDx(frame: PatternFrame): number {
  const scale = patternHandScale(frame);
  return (frame[2][0] - frame[8][0]) / scale;
}

function positionConfidence(position: RelativeHandPosition): number {
  if (position.region === "left_trigger") {
    const horizontalScore = Math.min(
      Math.abs(position.dx / LEFT_TRIGGER_DX),
      1.0,
    );
    const verticalScore = Math.min(
      position.dy / Math.max(LEFT_TRIGGER_MIN_DY, 0.001),
      1.0,
    );
    return horizontalScore * 0.75 + verticalScore * 0.25;
  }
  if (position.region === "right_trigger") {
    return Math.min(position.dx / RIGHT_TRIGGER_DX, 1.0);
  }
  return 0.0;
}

// --- the state machine -----------------------------------------------------

export class ActionTracker {
  anchor: AnchorSnapshot | null = null;
  phase: AnchorPhase = "NO_ANCHOR";
  currentPosition: RelativeHandPosition | null = null;
  leftSwipeCount = 0;
  rightSwipeCount = 0;
  lastEvent: ActionEvent | null = null;
  cooldownUntil = 0.0;
  handLostPhase: AnchorPhase | null = null;
  returnRequiresAnchorShape = false;
  motionSamples: MotionSample[] = [];

  setAnchor(frame: PatternFrame, now: number): void {
    const [width, aspect] = handWidthAndAspect(frame);
    this.anchor = {
      center: patternPalmCenter(frame),
      scale: patternHandScale(frame),
      width,
      aspect,
      enablesOpenPalmRightTrigger: isAnchorReturnShape(frame),
      createdAt: now,
    };
    this.currentPosition = this.relativePosition(frame);
    this.phase = "READY";
    this.cooldownUntil = 0.0;
    this.handLostPhase = null;
    this.returnRequiresAnchorShape = false;
    this.motionSamples = [
      { createdAt: now, position: this.currentPosition },
    ];
  }

  resetCount(): void {
    this.leftSwipeCount = 0;
    this.rightSwipeCount = 0;
    this.lastEvent = null;
    this.cooldownUntil = 0.0;
    this.handLostPhase = null;
    this.returnRequiresAnchorShape = false;
    this.motionSamples = [];
    if (this.anchor === null) {
      this.phase = "NO_ANCHOR";
    } else if (
      this.currentPosition !== null &&
      this.currentPosition.region === "near"
    ) {
      this.phase = "READY";
    }
  }

  clearMotion(): void {
    this.markNoHand();
  }

  markNoHand(): void {
    if (this.phase !== "NO_ANCHOR" && this.phase !== "NO_HAND") {
      this.handLostPhase = this.phase;
    }
    this.currentPosition = null;
    this.phase = this.anchor === null ? "NO_ANCHOR" : "NO_HAND";
  }

  update(frame: PatternFrame, now: number): ActionEvent | null {
    if (this.anchor === null) {
      this.phase = "NO_ANCHOR";
      this.currentPosition = null;
      this.motionSamples = [];
      return null;
    }

    const position = this.relativePosition(frame);
    this.currentPosition = position;
    const currentSample = this.rememberMotionSample(position, now);

    if (this.phase === "NO_HAND") {
      if (position.region === "near") {
        this.phase = "READY";
        this.handLostPhase = null;
      } else if (
        this.handLostPhase === "READY" ||
        this.handLostPhase === "ARMED"
      ) {
        this.phase = "ARMED";
      } else {
        this.phase = "WAIT_RETURN";
      }
    }

    if (this.phase === "WAIT_RETURN") {
      const readyToReturn =
        !this.returnRequiresAnchorShape || isAnchorReturnShape(frame);
      if (position.region === "near" && readyToReturn) {
        this.phase = "READY";
        this.handLostPhase = null;
        this.returnRequiresAnchorShape = false;
        this.motionSamples = [currentSample];
      }
      return null;
    }

    if (now < this.cooldownUntil) {
      return null;
    }

    const localLeftConfidence = this.localLeftConfidence(frame, position, now);
    if (localLeftConfidence !== null) {
      return this.recordEvent("LEFT SWIPE", position, now, {
        confidence: localLeftConfidence,
        returnRequiresAnchorShape: true,
      });
    }

    if (this.shouldRecordFingertipLeft(frame, position)) {
      return this.recordEvent("LEFT SWIPE", position, now, {
        confidence: 1.0,
        returnRequiresAnchorShape: true,
      });
    }

    if (this.shouldRecordOpenPalmRight(frame, position)) {
      return this.recordEvent("RIGHT SWIPE", position, now, {
        confidence: 1.0,
        returnRequiresAnchorShape: true,
      });
    }

    if (this.shouldRecordFingertipRight(frame, position)) {
      return this.recordEvent("RIGHT SWIPE", position, now, {
        confidence: 1.0,
        returnRequiresAnchorShape: true,
      });
    }

    if (position.region === "near") {
      this.phase = "READY";
      return null;
    }

    if (this.phase === "READY") {
      this.phase = "ARMED";
    }

    if (this.phase !== "ARMED") {
      return null;
    }

    if (position.region === "left_trigger") {
      return this.recordEvent("LEFT SWIPE", position, now);
    }

    if (position.region === "right_trigger") {
      return this.recordEvent("RIGHT SWIPE", position, now);
    }

    return null;
  }

  private rememberMotionSample(
    position: RelativeHandPosition,
    now: number,
  ): MotionSample {
    const sample: MotionSample = { createdAt: now, position };
    this.motionSamples.push(sample);
    this.motionSamples = this.motionSamples.filter(
      (motionSample) =>
        now - motionSample.createdAt <= LEFT_LOCAL_MOTION_SECONDS,
    );
    return sample;
  }

  private localLeftConfidence(
    frame: PatternFrame,
    position: RelativeHandPosition,
    now: number,
  ): number | null {
    if (this.phase !== "READY" && this.phase !== "ARMED") {
      return null;
    }

    if (position.dx > LEFT_LOCAL_TRIGGER_MAX_POSITION_DX) {
      return null;
    }

    let bestConfidence: number | null = null;
    for (const sample of this.motionSamples.slice(0, -1)) {
      if (now - sample.createdAt > LEFT_LOCAL_MOTION_SECONDS) {
        continue;
      }

      const startPosition = sample.position;
      if (startPosition.region !== "near") {
        continue;
      }

      if (startPosition.dx < LEFT_LOCAL_TRIGGER_MIN_START_DX) {
        continue;
      }

      const localDx = position.dx - startPosition.dx;
      const localDy = position.dy - startPosition.dy;
      if (localDx > LEFT_LOCAL_TRIGGER_DX) {
        continue;
      }

      if (localDy < LEFT_LOCAL_TRIGGER_DY) {
        continue;
      }

      const horizontalScore = Math.min(localDx / LEFT_LOCAL_TRIGGER_DX, 1.0);
      const verticalScore = Math.min(localDy / LEFT_LOCAL_TRIGGER_DY, 1.0);
      const confidence = horizontalScore * 0.7 + verticalScore * 0.3;
      if (bestConfidence === null || confidence > bestConfidence) {
        bestConfidence = confidence;
      }
    }

    const shapeConfidence = this.shapeGatedLeftConfidence(frame, position, now);
    if (shapeConfidence !== null) {
      if (bestConfidence === null || shapeConfidence > bestConfidence) {
        bestConfidence = shapeConfidence;
      }
    }

    return bestConfidence;
  }

  private shapeGatedLeftConfidence(
    frame: PatternFrame,
    position: RelativeHandPosition,
    now: number,
  ): number | null {
    if (position.dx > LEFT_SHAPE_TRIGGER_MAX_POSITION_DX) {
      return null;
    }

    if (!isLeftOpenTriggerShape(frame)) {
      return null;
    }

    let bestConfidence: number | null = null;
    for (const sample of this.motionSamples.slice(0, -1)) {
      if (now - sample.createdAt > LEFT_LOCAL_MOTION_SECONDS) {
        continue;
      }

      const startPosition = sample.position;
      if (startPosition.region !== "near") {
        continue;
      }

      if (startPosition.dx < LEFT_SHAPE_TRIGGER_MIN_START_DX) {
        continue;
      }

      const localDx = position.dx - startPosition.dx;
      const localDy = position.dy - startPosition.dy;
      if (localDx > LEFT_SHAPE_TRIGGER_DX) {
        continue;
      }

      if (localDy < LEFT_SHAPE_TRIGGER_DY) {
        continue;
      }

      const horizontalScore = Math.min(localDx / LEFT_SHAPE_TRIGGER_DX, 1.0);
      const verticalScore = Math.min(localDy / LEFT_SHAPE_TRIGGER_DY, 1.0);
      const confidence = horizontalScore * 0.6 + verticalScore * 0.4;
      if (bestConfidence === null || confidence > bestConfidence) {
        bestConfidence = confidence;
      }
    }

    return bestConfidence;
  }

  private shouldRecordOpenPalmRight(
    frame: PatternFrame,
    position: RelativeHandPosition,
  ): boolean {
    if (this.anchor === null) {
      return false;
    }
    if (!this.anchor.enablesOpenPalmRightTrigger) {
      return false;
    }
    if (this.phase !== "READY" && this.phase !== "ARMED") {
      return false;
    }
    if (position.dx < RIGHT_OPEN_TRIGGER_MIN_DX) {
      return false;
    }
    if (Math.abs(position.dy) > RIGHT_OPEN_TRIGGER_MAX_ABS_DY) {
      return false;
    }
    return isRightOpenTriggerShape(frame);
  }

  private shouldRecordFingertipLeft(
    frame: PatternFrame,
    position: RelativeHandPosition,
  ): boolean {
    if (this.anchor === null) {
      return false;
    }
    if (this.phase !== "READY" && this.phase !== "ARMED") {
      return false;
    }
    if (position.region !== "near") {
      return false;
    }
    if (Math.abs(position.dy) > LEFT_FINGER_MAX_ABS_CENTER_DY) {
      return false;
    }
    return areFingertipsLeftOfAnchor(this.anchor, frame);
  }

  private shouldRecordFingertipRight(
    frame: PatternFrame,
    position: RelativeHandPosition,
  ): boolean {
    if (this.anchor === null) {
      return false;
    }
    if (!this.anchor.enablesOpenPalmRightTrigger) {
      return false;
    }
    if (this.phase !== "READY" && this.phase !== "ARMED") {
      return false;
    }
    if (position.region !== "near") {
      return false;
    }
    if (position.dx > RIGHT_FINGER_MAX_CENTER_DX) {
      return false;
    }
    if (Math.abs(position.dy) > RIGHT_FINGER_MAX_ABS_CENTER_DY) {
      return false;
    }
    return areFingertipsRightOfAnchor(this.anchor, frame);
  }

  relativePosition(frame: PatternFrame): RelativeHandPosition {
    if (this.anchor === null) {
      return { dx: 0.0, dy: 0.0, region: "away" };
    }
    const [centerX, centerY] = patternPalmCenter(frame);
    const [anchorX, anchorY] = this.anchor.center;
    const dx = (centerX - anchorX) / this.anchor.scale;
    const dy = (centerY - anchorY) / this.anchor.scale;
    const region = classifyRegion(dx, dy);
    return { dx, dy, region };
  }

  private recordEvent(
    label: ActionLabel,
    position: RelativeHandPosition,
    now: number,
    options: {
      confidence?: number;
      returnRequiresAnchorShape?: boolean;
    } = {},
  ): ActionEvent {
    const event: ActionEvent = {
      label,
      position,
      confidence: options.confidence ?? positionConfidence(position),
      createdAt: now,
    };
    if (label === "LEFT SWIPE") {
      this.leftSwipeCount += 1;
    } else {
      this.rightSwipeCount += 1;
    }

    this.lastEvent = event;
    this.cooldownUntil = now + ACTION_COOLDOWN_SECONDS;
    this.phase = "WAIT_RETURN";
    this.handLostPhase = null;
    this.returnRequiresAnchorShape = options.returnRequiresAnchorShape ?? false;
    this.motionSamples = [];
    return event;
  }

  /** Headline + whether it is a fresh swipe flash. Feeds the gesture store. */
  headline(now: number): [string, boolean] {
    const event = this.lastEvent;
    const eventIsVisible =
      event !== null && now - event.createdAt <= ACTION_DISPLAY_SECONDS;
    if (eventIsVisible && event !== null) {
      return [event.label, true];
    }

    if (this.anchor === null) {
      return ["ANCHOR NOT SET", false];
    }
    if (this.phase === "NO_HAND") {
      return ["NO HAND", false];
    }
    if (this.phase === "WAIT_RETURN") {
      return ["RETURN TO ANCHOR", false];
    }
    if (this.phase === "READY") {
      return ["ANCHOR READY", false];
    }
    return ["TRACKING FROM ANCHOR", false];
  }
}
