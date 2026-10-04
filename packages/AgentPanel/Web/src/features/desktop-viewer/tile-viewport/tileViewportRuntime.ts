// Everything one mounted viewport is holding while a gesture is in flight.
//
// The viewport's behaviour is one long-lived closure by nature: a press, three moves and a
// release are four events that have to agree about what is happening, and the agreement is
// this object. It is built once per mount and handed to each part, so no part keeps a
// second copy of a fact another part writes.

import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import type { ViewportPoint } from "@/features/desktop-viewer/tile-viewport/tileViewportMath";
import type { PointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import type { RemoteCursorChange } from "@/features/desktop-viewer/pointer-input/remoteCursor";
import type { VelocityTracker } from "@/features/desktop-viewer/pointer-input/velocityTracker";
import type { createZoomView, ViewLayers } from "@/features/desktop-viewer/zoom/zoomModels";
import type { CursorImageCache } from "@/features/desktop-viewer/tile-viewport/cursorImageCache";
import type {
  ViewportGestureKind,
  ViewportGestureOutcome,
  ViewportGestureTelemetry,
} from "@/features/desktop-viewer/tile-viewport/TileViewport";

export interface ViewportRuntime {
  // --- the elements this mount owns ---
  frame: HTMLDivElement;
  inner: HTMLDivElement;
  puck: HTMLButtonElement | null;
  overlay: HTMLDivElement;
  fallback: SVGSVGElement;
  image: HTMLImageElement;
  layers: ViewLayers;
  view: ReturnType<typeof createZoomView>;

  // --- what a gesture in flight is ---
  /** The view to put back when the keyboard stops occluding the box, or null when it is not. */
  viewBeforeKeyboard: unknown;
  cursorHidden: boolean;
  pointers: Map<number, { x: number; y: number; startX: number; startY: number }>;
  lastTapAt: number;
  lastTapX: number;
  lastTapY: number;
  didCrossPointerSlop: boolean;
  hadMultiplePointers: boolean;
  pressedMouseButton: "left" | "right" | null;
  touchHoldTimer: number;
  touchPrimingTimer: number;
  touchPrimingArc: Animation | null;
  /** The finger scrolling under the puck: where it has been, for the coast it leaves. */
  scrollVelocity: VelocityTracker;
  /** Whether that finger has crossed the slop and opened a scroll yet. */
  scrollBegun: boolean;
  wheelIdleTimer: number;
  puckOffset: { right: number; bottom: number };
  puckPointer: {
    id: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    dragged: boolean;
  } | null;
  lastPuckTapAt: number;
  lastPuckTapX: number;
  lastPuckTapY: number;
  pendingPuckTap: number;
  activeGesture: {
    id: string;
    kind: ViewportGestureKind;
    startedAt: number;
    startReported: boolean;
  } | null;
  gestureInputAccepted: boolean;
  gestureTransformed: boolean;
  gestureEdgeFollowed: boolean;
  pointerSequenceConsumed: boolean;
  settleTimer: number;
  lastReaimAt: number;

  // --- what the mount was handed, copied here so the parts need only this object ---
  readonly absolutePointerRef: { current: boolean };
  readonly beforeRemoteClickRef: { current: (() => string | undefined) | undefined };
  readonly cursorImageCache: { current: CursorImageCache };
  readonly dragHalo: { current: HTMLSpanElement | null };
  readonly dragPriming: { current: HTMLSpanElement | null };
  readonly dragPrimingArc: { current: SVGCircleElement | null };
  readonly gestureTelemetryRef: { current: ((event: ViewportGestureTelemetry) => void) | undefined };
  readonly pointerGestureStartRef: { current: (() => boolean) | undefined };
  readonly scrollEngagedRef: { current: boolean };
  /** The cursor model and the gesture translator, shared with any trackpad on the same viewer. */
  readonly input: PointerInputSession;
  readonly keyboardPresentedRef: { current: boolean };
  readonly setScrollEngaged: (engaged: boolean) => void;
  readonly pointerMode: boolean;
  /** Draws the cursor without the picture driving it (Trackpad mode). */
  readonly showCursor: boolean;
  readonly sourceWidth: number;
  readonly sourceHeight: number;

  // --- what the parts do ---
  rounded: (value: number) => number;
  gestureDetail: (outcome?: ViewportGestureOutcome) => {
    kind: ViewportGestureKind;
    scale: number;
    tx: number;
    ty: number;
    outcome?: ViewportGestureOutcome;
    inputAccepted?: boolean;
    edgeFollowed?: boolean;
  };
  reportGestureStart: () => void;
  startGesture: (kind: ViewportGestureKind) => void;
  finishGesture: (outcome: ViewportGestureOutcome) => void;
  size: () => { w: number; h: number };
  scheduleSettle: () => void;
  apply: () => void;
  local: (event: PointerEvent | WheelEvent) => ViewportPoint;
  send: (input: DesktopPointerInput) => boolean;
  showDragPriming: (priming: boolean) => void;
  cancelTouchHold: () => void;
  showDragHeld: (held: boolean) => void;
  releaseMouseButton: () => void;
  releaseTouchDrag: () => boolean;
  armTouchHold: () => void;
  applyPuckOffset: (persist: boolean) => void;
  toggleZoomAtPointer: () => void;
  applyCursorEvent: (event: WebrtcCursorEvent) => void;
  cursorChanged: (change: RemoteCursorChange) => void;
  absoluteMouse: (event: PointerEvent) => boolean;
  warpRemoteCursor: (screen: ViewportPoint) => void;
  beginFingerScroll: (at: ViewportPoint, sampledAt: number) => void;
  fingerScrollSamples: (samples: readonly { at: ViewportPoint; sampledAt: number }[]) => void;
  endFingerScroll: (allowMomentum: boolean) => void;
  cancelFingerScroll: () => void;
  sendWheelScroll: (dx: number, dy: number) => void;
  armWheelIdle: () => void;
  endWheelScroll: () => void;
  down: (event: PointerEvent) => void;
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
  cancel: (event: PointerEvent) => void;
  wheel: (event: WheelEvent) => void;
  puckDown: (event: PointerEvent) => void;
  puckMove: (event: PointerEvent) => void;
  finishPuckPointer: (event: PointerEvent, cancelled: boolean) => void;
  puckUp: (event: PointerEvent) => void;
  puckCancel: (event: PointerEvent) => void;
  handleResize: () => void;
}
