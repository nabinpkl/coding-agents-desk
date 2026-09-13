// Everything one mounted viewport is holding while a gesture is in flight.
//
// The viewport's behaviour is one long-lived closure by nature: a press, three moves and a
// release are four events that have to agree about what is happening, and the agreement is
// this object. It is built once per mount and handed to each part, so no part keeps a
// second copy of a fact another part writes.

import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import type { ViewportPoint } from "./tileViewportMath";
import type { createZoomView, ViewLayers } from "../zoom/zoomModels";
import type { CursorImageCache } from "./cursorImageCache";
import type {
  ViewportGestureKind,
  ViewportGestureOutcome,
  ViewportGestureTelemetry,
} from "./TileViewport";

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
  remoteCursor: ViewportPoint;
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
  touchDragHeld: boolean;
  pendingPointerDx: number;
  pendingPointerDy: number;
  pointerFrame: number;
  lastPointerFrameAt: number;
  pendingScrollDx: number;
  pendingScrollDy: number;
  scrollFrame: number;
  scrollActive: boolean;
  lastScrollFrameAt: number;
  lastScrollSampleAt: number;
  lastScrollVelocity: { x: number; y: number };
  momentumFrame: number;
  momentumLastTime: number;
  momentumVelocity: { x: number; y: number };
  didEmitMomentumBegan: boolean;
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
  readonly acknowledgedCursorRevision: { current: number };
  readonly beforeRemoteClickRef: { current: (() => string | undefined) | undefined };
  readonly cursorImageCache: { current: CursorImageCache };
  readonly cursorRevision: { current: number };
  readonly dragHalo: { current: HTMLSpanElement | null };
  readonly dragPriming: { current: HTMLSpanElement | null };
  readonly dragPrimingArc: { current: SVGCircleElement | null };
  readonly gestureTelemetryRef: { current: ((event: ViewportGestureTelemetry) => void) | undefined };
  readonly pointerGestureStartRef: { current: (() => boolean) | undefined };
  readonly scrollEngagedRef: { current: boolean };
  readonly sendPointerInputRef: { current: ((input: DesktopPointerInput) => boolean) | undefined };
  readonly keyboardPresentedRef: { current: boolean };
  readonly setScrollEngaged: (engaged: boolean) => void;
  readonly pointerMode: boolean;
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
  applyRemoteMove: (dx: number, dy: number) => void;
  absoluteMouse: (event: PointerEvent) => boolean;
  warpRemoteCursor: (screen: ViewportPoint) => void;
  flushPointer: (now?: number) => void;
  schedulePointerFlush: () => void;
  flushScroll: (now?: number) => void;
  scheduleScrollFlush: () => void;
  stopMomentum: (emitEnd: boolean) => void;
  tickMomentum: (now: number) => void;
  startMomentum: (velocity: { x: number; y: number }) => void;
  endScroll: (allowMomentum: boolean) => void;
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
