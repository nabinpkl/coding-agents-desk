"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import {
  advanceRemoteCursor,
  pointerAccelerationGain,
  scrollAccelerationGain,
  type ViewportPoint,
} from "./tileViewportMath";
import { createZoomView, type SettleOutcome } from "./zoomModels";
import { getCaptureCrop, onCaptureCropApplied, onOverviewReady, setCaptureCrop } from "./captureCrop";
import { useZoomMode } from "./zoomMode";
import { useOverviewLayer } from "./overviewLayer";
import { CursorImageCache } from "./cursorImageCache";

export type ViewportGestureKind = "pointer" | "scroll" | "view-pan" | "pinch-pan";
export type ViewportGestureOutcome =
  | "click"
  | "move"
  | "drag"
  | "scroll"
  | "transformed"
  | "unchanged"
  | "superseded"
  | "cancelled";

export type ViewportGestureTelemetry = {
  gestureId: string;
  phase: "viewport-gesture-start" | "viewport-gesture-end";
  elapsedMs: number;
  detail: {
    kind: ViewportGestureKind;
    scale: number;
    tx: number;
    ty: number;
    outcome?: ViewportGestureOutcome;
    inputAccepted?: boolean;
    edgeFollowed?: boolean;
  };
} | {
  gestureId: string;
  phase: "viewport-settle";
  elapsedMs: number;
  detail: SettleOutcome;
};

const CURSOR_MIRROR_RENDER_SCALE = 0.7;
/** How long after the last zoom or pan before the capture is re-aimed. DeskZoom's settle delay. */
const VIEW_SETTLE_MS = 150;
/** Shortest gap between two re-aims; each one swaps the picture while the new stream negotiates. */
const VIEW_REAIM_INTERVAL_MS = 350;
const POINTER_SLOP = 3;
/** How long one finger stays still before it becomes a held button. */
const TOUCH_DRAG_HOLD_MS = 500;
/**
 * How long a finger rests before the priming ring appears at all.
 *
 * Drawing it on touch-down would put a ring under every tap, and almost every tap is a click. The
 * ring waits out the length of an ordinary tap and then shows the progress already made, so it
 * only ever appears for someone who is holding on purpose.
 */
const DRAG_PRIMING_DELAY_MS = 150;
const DRAG_PRIMING_RADIUS = 12;
const DRAG_PRIMING_CIRCUMFERENCE = 2 * Math.PI * DRAG_PRIMING_RADIUS;
const SCROLL_SLOP = 10;
const SCROLL_MOMENTUM_FLICK_THRESHOLD = 200;
const SCROLL_MOMENTUM_STOP_THRESHOLD = 30;
const SCROLL_MOMENTUM_DECAY_K = 2.8;
/**
 * How long the wheel has to be quiet before the remote scroll is ended.
 *
 * Long enough that neither a notched wheel between clicks nor a trackpad's own momentum stream
 * (both under ~60ms apart in Chrome on macOS) reads as a stop, short enough that the far Mac is
 * not left inside an open scroll phase after the hand is off.
 */
const WHEEL_SCROLL_IDLE_MS = 150;
const POINTER_SCROLL_PUCK_SIDE = 56;
const POINTER_SCROLL_PUCK_STORAGE_KEY = "agentdesk.pointer-scroll-puck-offset.v1";
const DEFAULT_POINTER_SCROLL_PUCK_OFFSET = { right: 16, bottom: 120 };

interface PointerScrollPuckOffset {
  right: number;
  bottom: number;
}

function storedPointerScrollPuckOffset(): PointerScrollPuckOffset {
  try {
    const stored = window.localStorage.getItem(POINTER_SCROLL_PUCK_STORAGE_KEY);
    if (!stored) return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
    const parsed = JSON.parse(stored) as Partial<PointerScrollPuckOffset>;
    if (typeof parsed.right !== "number" || !Number.isFinite(parsed.right)
        || typeof parsed.bottom !== "number" || !Number.isFinite(parsed.bottom)) {
      return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
    }
    return { right: parsed.right, bottom: parsed.bottom };
  } catch {
    return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
  }
}

/**
 * A map-style viewport around a live tile, or a relative Mac pointer surface.
 *
 * The video underneath stays a dumb GPU rectangle. This overlay owns EVERY
 * pointer (`touch-action: none`), which is also what stops a drag on the tile
 * from scrolling the page and shoving the video around: gestures on the tile
 * belong to the tile. The pan and zoom are one CSS transform on the content
 * wrapper, compositor-composited with the video, so no frame is ever redrawn
 * by the page. Pointer mode keeps one finger outside that mapping: like the
 * native client's Pointer mode and TeamViewer's mouse surface, one finger
 * moves the existing Mac pointer relatively and a tap clicks where it is.
 * Two fingers always own the local viewport, pinching about their centroid
 * and panning the zoomed picture without sending input to the Mac.
 *
 * Transform state lives in refs and is applied by direct style writes: a
 * pointermove per frame through React state would re-render the tile sixty
 * times a second for no layout change.
 */
export function TileViewport({
  children,
  className = "",
  pointerMode = false,
  absolutePointer = false,
  sendPointerInput,
  keyboardPresented = false,
  onPointerGestureStart,
  onBeforeRemoteClick,
  onGestureTelemetry,
  sourceWidth = 0,
  sourceHeight = 0,
  initialCursor,
  underlay,
  subscribeCursorEvents,
}: {
  children: ReactNode;
  className?: string;
  pointerMode?: boolean;
  /** Mouse only: put the remote cursor where the pointer is, instead of nudging it by deltas. */
  absolutePointer?: boolean;
  sendPointerInput?: (input: DesktopPointerInput) => boolean;
  keyboardPresented?: boolean;
  /** Returns true when the keyboard consumed the entire new pointer sequence. */
  onPointerGestureStart?: () => boolean;
  /** Runs synchronously inside the confirmed tap gesture, before the remote click is sent. */
  onBeforeRemoteClick?: () => string | undefined;
  onGestureTelemetry?: (event: ViewportGestureTelemetry) => void;
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * A coarse picture of the whole display, drawn under `children`. Crop mode places it by the whole
   * display and the sharp picture by its region, so wherever the sharp one is not, this one is.
   */
  underlay?: ReactNode;
  initialCursor?: ViewportPoint;
  subscribeCursorEvents?: (listener: (event: WebrtcCursorEvent) => void) => () => void;
}) {
  const zoomMode = useZoomMode();
  const overviewLayer = useOverviewLayer();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const underlayContent = useRef<HTMLDivElement>(null);
  const scrollPuck = useRef<HTMLButtonElement>(null);
  const cursorOverlay = useRef<HTMLDivElement>(null);
  const cursorFallback = useRef<SVGSVGElement>(null);
  const cursorImage = useRef<HTMLImageElement>(null);
  const dragHalo = useRef<HTMLSpanElement>(null);
  const dragPriming = useRef<HTMLSpanElement>(null);
  const dragPrimingArc = useRef<SVGCircleElement>(null);
  const cursorImageCache = useRef(new CursorImageCache());
  const sendPointerInputRef = useRef(sendPointerInput);
  const pointerGestureStartRef = useRef(onPointerGestureStart);
  const beforeRemoteClickRef = useRef(onBeforeRemoteClick);
  const keyboardPresentedRef = useRef(keyboardPresented);
  const gestureTelemetryRef = useRef(onGestureTelemetry);
  const cursorRevision = useRef(0);
  const absolutePointerRef = useRef(absolutePointer);
  const acknowledgedCursorRevision = useRef(0);
  const scrollEngagedRef = useRef(false);
  const [scrollEngaged, setScrollEngagedState] = useState(false);

  const setScrollEngaged = (engaged: boolean) => {
    scrollEngagedRef.current = engaged;
    setScrollEngagedState(engaged);
  };

  useEffect(() => {
    sendPointerInputRef.current = sendPointerInput;
  }, [sendPointerInput]);
  useEffect(() => {
    absolutePointerRef.current = absolutePointer;
  }, [absolutePointer]);

  useEffect(() => {
    pointerGestureStartRef.current = onPointerGestureStart;
  }, [onPointerGestureStart]);

  useEffect(() => {
    beforeRemoteClickRef.current = onBeforeRemoteClick;
  }, [onBeforeRemoteClick]);

  // Read at resize time rather than in the layout effect's deps, which would rebind every pointer
  // listener and reset the view each time the keyboard came and went.
  useEffect(() => {
    keyboardPresentedRef.current = keyboardPresented;
  }, [keyboardPresented]);

  useEffect(() => {
    gestureTelemetryRef.current = onGestureTelemetry;
  }, [onGestureTelemetry]);

  useLayoutEffect(() => {
    const frame = viewport.current;
    const inner = content.current;
    const puck = scrollPuck.current;
    const overlay = cursorOverlay.current;
    const fallback = cursorFallback.current;
    const image = cursorImage.current;
    if (!frame || !inner || !overlay || !fallback || !image) return undefined;
    if (!pointerMode && scrollEngagedRef.current) setScrollEngaged(false);

    const layers = { content: inner, underlay: underlayContent.current };
    // A plan the previous display's view settled after the switch is a request for the wrong
    // screen; the streams beneath would send it to the new one.
    if (zoomMode === "crop") {
      const stored = getCaptureCrop();
      if (stored && (stored.display.width !== sourceWidth || stored.display.height !== sourceHeight)) {
        setCaptureCrop(null);
      }
    }
    const view = createZoomView(
      zoomMode,
      { width: sourceWidth, height: sourceHeight },
      { overview: zoomMode === "crop" && overviewLayer },
    );
    /** The view to put back when the keyboard stops occluding the box, or null when it is not. */
    let viewBeforeKeyboard: unknown = null;
    let remoteCursor = advanceRemoteCursor(
      initialCursor ?? { x: sourceWidth / 2, y: sourceHeight / 2 },
      0,
      0,
      sourceWidth,
      sourceHeight,
    );
    let cursorHidden = false;
    const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let didCrossPointerSlop = false;
    let hadMultiplePointers = false;
    let pressedMouseButton: "left" | "right" | null = null;
    let touchHoldTimer = 0;
    let touchPrimingTimer = 0;
    let touchPrimingArc: Animation | null = null;
    let touchDragHeld = false;
    let pendingPointerDx = 0;
    let pendingPointerDy = 0;
    let pointerFrame = 0;
    let lastPointerFrameAt = performance.now();
    let pendingScrollDx = 0;
    let pendingScrollDy = 0;
    let scrollFrame = 0;
    let scrollActive = false;
    let lastScrollFrameAt = performance.now();
    let lastScrollSampleAt = performance.now();
    let lastScrollVelocity = { x: 0, y: 0 };
    let momentumFrame = 0;
    let momentumLastTime = 0;
    let momentumVelocity = { x: 0, y: 0 };
    let didEmitMomentumBegan = false;
    let wheelIdleTimer = 0;
    let puckOffset = storedPointerScrollPuckOffset();
    let puckPointer: {
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      dragged: boolean;
    } | null = null;
    let lastPuckTapAt = Number.NEGATIVE_INFINITY;
    let lastPuckTapX = 0;
    let lastPuckTapY = 0;
    let pendingPuckTap = 0;
    let activeGesture: {
      id: string;
      kind: ViewportGestureKind;
      startedAt: number;
      startReported: boolean;
    } | null = null;
    let gestureInputAccepted = true;
    let gestureTransformed = false;
    let gestureEdgeFollowed = false;
    let pointerSequenceConsumed = false;

    const rounded = (value: number) => Math.round(value * 1_000) / 1_000;
    const gestureDetail = (outcome?: ViewportGestureOutcome) => ({
      kind: activeGesture!.kind,
      scale: rounded(view.telemetry().scale),
      tx: rounded(view.telemetry().tx),
      ty: rounded(view.telemetry().ty),
      ...(outcome ? { outcome } : {}),
      ...((activeGesture!.kind === "pointer" || activeGesture!.kind === "scroll") && outcome
        ? {
            inputAccepted: gestureInputAccepted,
            ...(activeGesture!.kind === "pointer" ? { edgeFollowed: gestureEdgeFollowed } : {}),
          }
        : {}),
    });
    const reportGestureStart = () => {
      if (!activeGesture || activeGesture.startReported) return;
      activeGesture.startReported = true;
      gestureTelemetryRef.current?.({
        gestureId: activeGesture.id,
        phase: "viewport-gesture-start",
        elapsedMs: 0,
        detail: gestureDetail(),
      });
    };
    const startGesture = (kind: ViewportGestureKind) => {
      const now = performance.now();
      activeGesture = {
        id: crypto.randomUUID(),
        kind,
        startedAt: now,
        startReported: false,
      };
      gestureInputAccepted = true;
      gestureTransformed = false;
      gestureEdgeFollowed = false;
      // Multi-touch is meaningful from the second finger down. One-finger
      // candidates stay quiet until they move, keeping taps to one log event.
      if (kind === "pinch-pan") reportGestureStart();
    };
    const finishGesture = (outcome: ViewportGestureOutcome) => {
      if (!activeGesture) return;
      if (outcome === "superseded" && !activeGesture.startReported) {
        activeGesture = null;
        return;
      }
      gestureTelemetryRef.current?.({
        gestureId: activeGesture.id,
        phase: "viewport-gesture-end",
        elapsedMs: Math.max(0, Math.round(performance.now() - activeGesture.startedAt)),
        detail: gestureDetail(outcome),
      });
      activeGesture = null;
    };

    const size = () => ({ w: frame.clientWidth, h: frame.clientHeight });
    let settleTimer = 0;
    let lastReaimAt = Number.NEGATIVE_INFINITY;
    /**
     * One capture request per settled gesture, and never two within the re-aim interval. A pinch
     * rewrites the view every animation frame and each re-aim costs a renegotiation, so the
     * request waits for the hand to stop and then for the last re-aim to be old enough.
     */
    const scheduleSettle = () => {
      if (settleTimer !== 0) window.clearTimeout(settleTimer);
      const wait = Math.max(VIEW_SETTLE_MS, VIEW_REAIM_INTERVAL_MS - (performance.now() - lastReaimAt));
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        lastReaimAt = performance.now();
        const { w, h } = size();
        const decided = view.settle(w, h);
        // The one trace of what a phone's view decided; the sidecar log is where it can be read.
        if (decided.outcome !== "css") {
          gestureTelemetryRef.current?.({
            gestureId: activeGesture?.id ?? "settle",
            phase: "viewport-settle",
            elapsedMs: 0,
            detail: decided,
          });
        }
      }, wait);
    };
    // A requested plan is now on screen: the frame covers its region, so place it by that. Then
    // settle again, because the view may have moved while that plan was being negotiated and the
    // model holds one re-aim at a time; if it did not move, the plan serves and nothing happens.
    const stopWatchingCrop = onCaptureCropApplied((plan) => {
      view.applied(plan);
      apply();
      scheduleSettle();
    });
    // The overview has painted: a sharp request that was waiting on it can go out now.
    const stopWatchingOverview = onOverviewReady(() => scheduleSettle());
    const apply = () => {
      const { w, h } = size();
      view.paint(layers, w, h);
      const projected = view.project(remoteCursor, w, h);
      overlay.hidden = !pointerMode || cursorHidden || projected === null;
      if (projected) {
        // The overlay origin is the hotspot. The glyph supplies its own offset and stays
        // phone-sized outside the transformed content while that origin follows the video.
        overlay.style.transform = `translate3d(${projected.x}px, ${projected.y}px, 0)`;
      }
    };
    const local = (event: PointerEvent | WheelEvent) => {
      const box = frame.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const send = (input: DesktopPointerInput) => sendPointerInputRef.current?.(input) ?? false;
    /**
     * A finger held still becomes a held mouse button, so a drag can be carried and dropped.
     *
     * A phone has no button to hold: a tap is a whole click and a moving finger walks the cursor,
     * which between them cannot drag a title bar, a slider, a file, or a text selection. Holding
     * presses, moving carries, lifting drops. Nothing native was needed for it -- the helper
     * already reports movement as a drag whenever a button is down -- so this only decides when to
     * press and when to let go.
     *
     * Letting go is the part that matters. A button left down on the far Mac outlives the gesture,
     * the viewer, and the page, so every exit releases: the lift, a cancelled pointer, a second
     * finger arriving, and the effect's own teardown.
     */
    /**
     * Show how much of the hold is left, as a ring that closes on the moment the drag arms.
     *
     * It is started from the progress already elapsed rather than from zero, so the ring is a
     * reading of the same timer rather than a second animation that happens to take a similar
     * time. jsdom implements no Web Animations, hence the optional call; the ring's visibility is
     * the part the tests can see.
     */
    const showDragPriming = (priming: boolean) => {
      const ring = dragPriming.current;
      if (!ring) return;
      touchPrimingArc?.cancel();
      touchPrimingArc = null;
      ring.hidden = !priming;
      if (!priming) return;
      const elapsed = DRAG_PRIMING_DELAY_MS / TOUCH_DRAG_HOLD_MS;
      touchPrimingArc = dragPrimingArc.current?.animate?.(
        [
          { strokeDashoffset: DRAG_PRIMING_CIRCUMFERENCE * (1 - elapsed) },
          { strokeDashoffset: 0 },
        ],
        { duration: TOUCH_DRAG_HOLD_MS - DRAG_PRIMING_DELAY_MS, easing: "linear", fill: "forwards" },
      ) ?? null;
    };
    const cancelTouchHold = () => {
      // Ahead of the timer check: the ring outlives the timer by the moment the hold fires in, and
      // a ring left on screen is worse than one that never showed.
      showDragPriming(false);
      if (touchPrimingTimer !== 0) {
        window.clearTimeout(touchPrimingTimer);
        touchPrimingTimer = 0;
      }
      if (touchHoldTimer === 0) return;
      window.clearTimeout(touchHoldTimer);
      touchHoldTimer = 0;
    };
    const showDragHeld = (held: boolean) => {
      const halo = dragHalo.current;
      if (halo) halo.hidden = !held;
    };
    /**
     * Let go of a mouse button, wherever the sequence ends.
     *
     * A mouse holds its own button rather than earning one by waiting, so it never goes through
     * the touch hold; it still has to be let go on every exit, including the teardown, for the
     * same reason a held finger does. A button left down on the far Mac outlives the page.
     */
    const releaseMouseButton = () => {
      if (pressedMouseButton === null) return;
      send({ type: "mouse-up", button: pressedMouseButton });
      pressedMouseButton = null;
      showDragHeld(false);
    };
    /** True when a held button was actually let go, which is what suppresses the tap-click. */
    const releaseTouchDrag = () => {
      if (!touchDragHeld) return false;
      touchDragHeld = false;
      showDragHeld(false);
      gestureInputAccepted = send({ type: "mouse-up", button: "left" }) && gestureInputAccepted;
      return true;
    };
    const armTouchHold = () => {
      cancelTouchHold();
      touchPrimingTimer = window.setTimeout(() => {
        touchPrimingTimer = 0;
        if (didCrossPointerSlop || hadMultiplePointers || pointers.size !== 1) return;
        showDragPriming(true);
      }, DRAG_PRIMING_DELAY_MS);
      touchHoldTimer = window.setTimeout(() => {
        touchHoldTimer = 0;
        // The ring has done its job either way: what follows is the held state or nothing.
        showDragPriming(false);
        // The finger has to still be down, alone, and to have stayed inside the slop. Any of those
        // failing means this was a move, a pinch, or a tap that already ended.
        if (didCrossPointerSlop || hadMultiplePointers || pointers.size !== 1) return;
        if (!send({ type: "mouse-down", button: "left" })) {
          gestureInputAccepted = false;
          return;
        }
        touchDragHeld = true;
        showDragHeld(true);
      }, TOUCH_DRAG_HOLD_MS);
    };
    const applyPuckOffset = (persist: boolean) => {
      if (!puck) return;
      const { w, h } = size();
      if (w > 0 && h > 0) {
        puckOffset = {
          right: Math.min(Math.max(0, puckOffset.right), Math.max(0, w - POINTER_SCROLL_PUCK_SIDE)),
          bottom: Math.min(Math.max(0, puckOffset.bottom), Math.max(0, h - POINTER_SCROLL_PUCK_SIDE)),
        };
      }
      puck.style.right = `${puckOffset.right}px`;
      puck.style.bottom = `max(${puckOffset.bottom}px, var(--desktop-chrome-clearance, 0px))`;
      if (!persist) return;
      try {
        window.localStorage.setItem(POINTER_SCROLL_PUCK_STORAGE_KEY, JSON.stringify(puckOffset));
      } catch {
        // The position is a convenience. A storage-denied webview keeps the current placement.
      }
    };
    const toggleZoomAtPointer = () => {
      const { w, h } = size();
      const projected = view.project(remoteCursor, w, h) ?? { x: w / 2, y: h / 2 };
      if (view.isZoomed()) view.reset();
      else view.zoomAt(2.5, projected.x, projected.y, w, h);
      scheduleSettle();
      apply();
    };
    const applyCursorEvent = (event: WebrtcCursorEvent) => {
      if (event.type === "cursor-applied") {
        acknowledgedCursorRevision.current = Math.max(
          acknowledgedCursorRevision.current,
          event.revision,
        );
        if (event.revision !== cursorRevision.current) return;
        remoteCursor = advanceRemoteCursor(event, 0, 0, sourceWidth, sourceHeight);
        if (pointers.size < 2) {
          const { w, h } = size();
          if (view.follow(remoteCursor, w, h)) scheduleSettle();
        }
        apply();
        return;
      }
      if (event.type === "cursor-position") {
        if (acknowledgedCursorRevision.current < cursorRevision.current) return;
        remoteCursor = advanceRemoteCursor(event, 0, 0, sourceWidth, sourceHeight);
        if (pointers.size < 2) {
          const { w, h } = size();
          if (view.follow(remoteCursor, w, h)) scheduleSettle();
        }
        apply();
        return;
      }

      cursorHidden = event.hidden;
      overlay.dataset.cursorKind = event.cursorKind;
      const resolved = cursorImageCache.current.resolve(event);
      if (resolved) {
        const width = resolved.widthPoints * CURSOR_MIRROR_RENDER_SCALE;
        const height = resolved.heightPoints * CURSOR_MIRROR_RENDER_SCALE;
        image.src = resolved.source;
        image.style.width = `${width}px`;
        image.style.height = `${height}px`;
        image.style.transform = `translate(${-resolved.hotspotXFrac * width}px, ${-resolved.hotspotYFrac * height}px)`;
        image.hidden = false;
        fallback.setAttribute("hidden", "");
      }
      apply();
    };
    const applyRemoteMove = (dx: number, dy: number) => {
      const revision = cursorRevision.current + 1;
      const accepted = send({ type: "pointer-move", revision, dx, dy });
      gestureInputAccepted = accepted && gestureInputAccepted;
      if (!accepted || sourceWidth <= 0 || sourceHeight <= 0) return;
      cursorRevision.current = revision;
      remoteCursor = advanceRemoteCursor(remoteCursor, dx, dy, sourceWidth, sourceHeight);
      if (pointers.size < 2) {
        const { w, h } = size();
        if (view.follow(remoteCursor, w, h)) {
          gestureEdgeFollowed = true;
          scheduleSettle();
        }
      }
      apply();
    };
    /**
     * Absolute pointing for a mouse: the pointer has a position on the picture, so the remote
     * cursor is placed at the matching source pixel rather than walked there by deltas. Runs on
     * plain hover too -- a mouse moves without a button held, and that is exactly when the cursor
     * should follow.
     */
    const absoluteMouse = (event: PointerEvent) =>
      pointerMode && absolutePointerRef.current && event.pointerType === "mouse";
    const warpRemoteCursor = (screen: ViewportPoint) => {
      if (sourceWidth <= 0 || sourceHeight <= 0) return;
      const { w, h } = size();
      const target = view.unproject(screen, w, h);
      if (!target) return;
      if (Math.round(target.x) === Math.round(remoteCursor.x)
          && Math.round(target.y) === Math.round(remoteCursor.y)) return;
      const revision = cursorRevision.current + 1;
      if (!send({ type: "pointer-warp", revision, x: target.x, y: target.y })) return;
      cursorRevision.current = revision;
      remoteCursor = target;
      apply();
    };
    const flushPointer = (now = performance.now()) => {
      pointerFrame = 0;
      if (pendingPointerDx === 0 && pendingPointerDy === 0) return;
      const dx = pendingPointerDx;
      const dy = pendingPointerDy;
      pendingPointerDx = 0;
      pendingPointerDy = 0;
      const elapsed = Math.max((now - lastPointerFrameAt) / 1_000, 0.001);
      lastPointerFrameAt = now;
      const gain = pointerAccelerationGain(Math.hypot(dx, dy) / elapsed);
      const remoteDx = dx * gain;
      const remoteDy = dy * gain;
      applyRemoteMove(remoteDx, remoteDy);
    };
    const schedulePointerFlush = () => {
      if (pointerFrame !== 0) return;
      pointerFrame = window.requestAnimationFrame(flushPointer);
    };
    const flushScroll = (now = performance.now()) => {
      scrollFrame = 0;
      if (pendingScrollDx === 0 && pendingScrollDy === 0) return;
      const dx = pendingScrollDx;
      const dy = pendingScrollDy;
      pendingScrollDx = 0;
      pendingScrollDy = 0;
      const elapsed = Math.max((now - lastScrollFrameAt) / 1_000, 0.001);
      lastScrollFrameAt = now;
      const gain = scrollAccelerationGain(Math.hypot(dx, dy) / elapsed);
      // Deliberately matches the native client's current LinearMouse-calibrated default:
      // raw finger deltas pass through with the same sign on both axes.
      gestureInputAccepted = send({
        type: "scroll",
        dx: dx * gain,
        dy: dy * gain,
        phase: scrollActive ? "changed" : "began",
      }) && gestureInputAccepted;
      scrollActive = true;
    };
    const scheduleScrollFlush = () => {
      if (scrollFrame !== 0) return;
      scrollFrame = window.requestAnimationFrame(flushScroll);
    };
    const stopMomentum = (emitEnd: boolean) => {
      const wasRunning = momentumFrame !== 0;
      if (momentumFrame !== 0) window.cancelAnimationFrame(momentumFrame);
      momentumFrame = 0;
      momentumVelocity = { x: 0, y: 0 };
      if (emitEnd && wasRunning && didEmitMomentumBegan) {
        gestureInputAccepted = send({
          type: "scroll", dx: 0, dy: 0, phase: "momentumEnded",
        }) && gestureInputAccepted;
      }
      didEmitMomentumBegan = false;
    };
    const tickMomentum = (now: number) => {
      momentumFrame = 0;
      const elapsed = Math.max((now - momentumLastTime) / 1_000, 0.001);
      momentumLastTime = now;
      const decay = Math.exp(-SCROLL_MOMENTUM_DECAY_K * elapsed);
      momentumVelocity = {
        x: momentumVelocity.x * decay,
        y: momentumVelocity.y * decay,
      };
      const speed = Math.hypot(momentumVelocity.x, momentumVelocity.y);
      if (speed < SCROLL_MOMENTUM_STOP_THRESHOLD) {
        if (didEmitMomentumBegan) {
          gestureInputAccepted = send({
            type: "scroll", dx: 0, dy: 0, phase: "momentumEnded",
          }) && gestureInputAccepted;
        }
        didEmitMomentumBegan = false;
        return;
      }
      const gain = scrollAccelerationGain(speed);
      gestureInputAccepted = send({
        type: "scroll",
        dx: momentumVelocity.x * elapsed * gain,
        dy: momentumVelocity.y * elapsed * gain,
        phase: didEmitMomentumBegan ? "momentumChanged" : "momentumBegan",
      }) && gestureInputAccepted;
      didEmitMomentumBegan = true;
      momentumFrame = window.requestAnimationFrame(tickMomentum);
    };
    const startMomentum = (velocity: { x: number; y: number }) => {
      stopMomentum(false);
      momentumVelocity = velocity;
      momentumLastTime = performance.now();
      momentumFrame = window.requestAnimationFrame(tickMomentum);
    };
    const endScroll = (allowMomentum: boolean) => {
      if (scrollFrame !== 0) window.cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      flushScroll();
      if (scrollActive) {
        gestureInputAccepted = send({
          type: "scroll", dx: 0, dy: 0, phase: "ended",
        }) && gestureInputAccepted;
      }
      const liftVelocity = lastScrollVelocity;
      scrollActive = false;
      pendingScrollDx = 0;
      pendingScrollDy = 0;
      lastScrollVelocity = { x: 0, y: 0 };
      if (allowMomentum && Math.hypot(liftVelocity.x, liftVelocity.y) >= SCROLL_MOMENTUM_FLICK_THRESHOLD) {
        startMomentum(liftVelocity);
      }
    };
    /**
     * A wheel delta is already the scroll the OS decided on, so it goes out as it is.
     *
     * The finger path accumulates raw travel and accelerates it at flush time, because a finger
     * reports where it is and the curve is what turns that into a scroll. A wheel reports a scroll
     * directly, with macOS's own acceleration already in it, and it arrives whole inside one
     * frame: measured, five notches pushed through the finger curve came out as 7500 points,
     * because 500 points in 16ms reads as a flick. Sending each event as it lands also keeps the
     * wheel off the animation frame, which a hidden or throttled tab never runs.
     */
    const sendWheelScroll = (dx: number, dy: number) => {
      gestureInputAccepted = send({
        type: "scroll",
        dx,
        dy,
        phase: scrollActive ? "changed" : "began",
      }) && gestureInputAccepted;
      scrollActive = true;
    };
    /**
     * A wheel has no lift, so the end of a wheel scroll is inferred from silence.
     *
     * The finger path closes its scroll on pointerup, and the Mac needs that `ended` to close the
     * phase the first delta opened. Nothing in a wheel stream says the hand stopped: a trackpad's
     * own inertia keeps arriving as ordinary wheel events and a notched wheel simply goes quiet.
     * A timer restarted on every wheel event is therefore the lift. It also means the trackpad's
     * momentum is forwarded as the real `changed` deltas it already is, rather than being thrown
     * away and re-synthesised here on top of itself.
     */
    const armWheelIdle = () => {
      if (wheelIdleTimer !== 0) window.clearTimeout(wheelIdleTimer);
      wheelIdleTimer = window.setTimeout(() => {
        wheelIdleTimer = 0;
        endScroll(false);
      }, WHEEL_SCROLL_IDLE_MS);
    };
    /** Close a wheel scroll now, for anything that supersedes it or tears the surface down. */
    const endWheelScroll = () => {
      if (wheelIdleTimer === 0) return;
      window.clearTimeout(wheelIdleTimer);
      wheelIdleTimer = 0;
      endScroll(false);
    };
    const down = (event: PointerEvent) => {
      // A press supersedes a wheel scroll still waiting out its idle timer; the far Mac must not
      // be left inside an open phase while a button goes down.
      endWheelScroll();
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that vanished between down and capture still pans fine;
        // losing capture only costs tracking outside the element.
      }
      const at = local(event);
      // A press can arrive without a hover first (entering the window already clicking), so put the
      // cursor under it now: the click that follows on release fires wherever the cursor is.
      if (absoluteMouse(event)) {
        // Land the cursor first, then hold the button: a drag is press, move, release, and the
        // press has to happen where the pointer actually is.
        warpRemoteCursor(at);
        send({ type: "mouse-down", button: event.button === 2 ? "right" : "left" });
        pressedMouseButton = event.button === 2 ? "right" : "left";
        // The same held marker a finger gets. A mouse drag reads as nothing at all without it:
        // the button is down on the Mac and the panel shows no sign of it.
        showDragHeld(true);
        return;
      }
      const countBefore = pointers.size;
      if (countBefore === 0) {
        pointerSequenceConsumed = pointerGestureStartRef.current?.() === true;
      }
      if (pointerSequenceConsumed) {
        pointers.set(event.pointerId, { ...at, startX: at.x, startY: at.y });
        return;
      }
      if (countBefore === 0) {
        if (pointerMode && scrollEngagedRef.current) stopMomentum(true);
        didCrossPointerSlop = false;
        hadMultiplePointers = false;
        pendingPointerDx = 0;
        pendingPointerDy = 0;
        lastPointerFrameAt = performance.now();
        pendingScrollDx = 0;
        pendingScrollDy = 0;
        scrollActive = false;
        lastScrollVelocity = { x: 0, y: 0 };
        lastScrollFrameAt = performance.now();
        lastScrollSampleAt = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
      } else {
        hadMultiplePointers = true;
        if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
        pendingPointerDx = 0;
        pendingPointerDy = 0;
        if (scrollFrame !== 0 || scrollActive) endScroll(false);
      }
      pointers.set(event.pointerId, { ...at, startX: at.x, startY: at.y });
      if (countBefore === 0) {
        startGesture(pointerMode
          ? (scrollEngagedRef.current ? "scroll" : "pointer")
          : "view-pan");
        // Only a lone finger meant for the remote pointer can become a held button. A scrolling
        // finger already means something else, and view-pan never touches the far Mac.
        if (pointerMode && !scrollEngagedRef.current) armTouchHold();
      } else if (countBefore === 1) {
        cancelTouchHold();
        releaseTouchDrag();
        finishGesture("superseded");
        startGesture("pinch-pan");
      }
    };

    const move = (event: PointerEvent) => {
      // Before the tracking guard on purpose: a hovering mouse has no pointerdown behind it, and
      // hover is precisely when an absolute cursor should follow.
      if (absoluteMouse(event)) {
        const samples = event.getCoalescedEvents?.() ?? [event];
        warpRemoteCursor(local(samples[samples.length - 1] ?? event));
        return;
      }
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      if (pointerSequenceConsumed) return;
      if (pointerMode && pointers.size === 1) {
        const samples = event.getCoalescedEvents?.() ?? [event];
        for (const sample of samples.length > 0 ? samples : [event]) {
          const before = pointers.get(event.pointerId);
          if (!before) break;
          const now = local(sample);
          pointers.set(event.pointerId, { ...before, ...now });
          if (hadMultiplePointers) continue;
          if (!didCrossPointerSlop) {
            const slop = scrollEngagedRef.current ? SCROLL_SLOP : POINTER_SLOP;
            if (Math.hypot(now.x - before.startX, now.y - before.startY) < slop) continue;
            cancelTouchHold();
            didCrossPointerSlop = true;
            reportGestureStart();
          }
          const dx = now.x - before.x;
          const dy = now.y - before.y;
          if (scrollEngagedRef.current) {
            const sampleAt = Number.isFinite(sample.timeStamp) ? sample.timeStamp : performance.now();
            const elapsed = Math.max((sampleAt - lastScrollSampleAt) / 1_000, 0.001);
            lastScrollSampleAt = sampleAt;
            if (dx !== 0 || dy !== 0) {
              lastScrollVelocity = { x: dx / elapsed, y: dy / elapsed };
              pendingScrollDx += dx;
              pendingScrollDy += dy;
              scheduleScrollFlush();
            }
          } else {
            pendingPointerDx += dx;
            pendingPointerDy += dy;
            schedulePointerFlush();
          }
        }
        return;
      }

      const now = local(event);
      pointers.set(event.pointerId, { ...previous, ...now });
      const { w, h } = size();

      if (pointers.size === 2) {
        const otherPrevious = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (!otherPrevious) return;
        // Distance change about the centroid zooms; centroid drift pans.
        const previousDistance = Math.hypot(otherPrevious.x - previous.x, otherPrevious.y - previous.y);
        const distance = Math.hypot(otherPrevious.x - now.x, otherPrevious.y - now.y);
        const cx = (otherPrevious.x + now.x) / 2;
        const cy = (otherPrevious.y + now.y) / 2;
        if (previousDistance > 0 && distance > 0) {
          gestureTransformed = view.zoomAt(distance / previousDistance, cx, cy, w, h) || gestureTransformed;
        }
        gestureTransformed = view.panBy((now.x - previous.x) / 2, (now.y - previous.y) / 2, w, h) || gestureTransformed;
        apply();
        return;
      }
      if (!pointerMode && pointers.size === 1 && view.isZoomed()) {
        reportGestureStart();
        gestureTransformed = view.panBy(now.x - previous.x, now.y - previous.y, w, h) || gestureTransformed;
        apply();
      }
    };

    const up = (event: PointerEvent) => {
      const at = pointers.get(event.pointerId);
      if (pressedMouseButton !== null && event.pointerType === "mouse") {
        // The whole mouse sequence is press/release; the tap-to-click path below is for fingers.
        pointers.delete(event.pointerId);
        releaseMouseButton();
        return;
      }
      const countBefore = pointers.size;
      pointers.delete(event.pointerId);
      if (pointers.size === 0 && gestureTransformed) scheduleSettle();
      if (!at) return;
      if (pointerSequenceConsumed) {
        if (pointers.size === 0) pointerSequenceConsumed = false;
        return;
      }
      if (pointerMode) {
        if (countBefore === 1) {
          if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
          pointerFrame = 0;
          if (scrollEngagedRef.current && !hadMultiplePointers) {
            endScroll(didCrossPointerSlop);
          } else {
            flushPointer();
          }
          cancelTouchHold();
          const dropped = releaseTouchDrag();
          if (!dropped && !hadMultiplePointers && !didCrossPointerSlop) {
            const focusRequestId = beforeRemoteClickRef.current?.();
            gestureInputAccepted = send({
              type: "click",
              button: "left",
              ...(focusRequestId ? { focusRequestId } : {}),
            })
              && gestureInputAccepted;
          }
          if (activeGesture?.kind === "pinch-pan") {
            finishGesture(gestureTransformed ? "transformed" : "unchanged");
          } else if (dropped) {
            finishGesture("drag");
          } else {
            finishGesture(didCrossPointerSlop
              ? (scrollEngagedRef.current ? "scroll" : "move")
              : "click");
          }
        }
        return;
      }
      // Manual double-tap: two quick releases near the same spot. dblclick is
      // unreliable for touch inside a WKWebView.
      const nowMs = performance.now();
      if (nowMs - lastTapAt < 300 && Math.hypot(at.x - lastTapX, at.y - lastTapY) < 24) {
        const { w, h } = size();
        if (view.isZoomed()) view.reset();
        else view.zoomAt(2.5, at.x, at.y, w, h);
        scheduleSettle();
        apply();
        lastTapAt = 0;
        finishGesture("transformed");
        return;
      }
      lastTapAt = nowMs;
      lastTapX = at.x;
      lastTapY = at.y;
      if (pointers.size === 0) {
        finishGesture(gestureTransformed ? "transformed" : "unchanged");
      }
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pressedMouseButton !== null && event.pointerType === "mouse") {
        // A cancelled drag still has to let go, or the Mac is left with a button held down.
        releaseMouseButton();
        return;
      }
      cancelTouchHold();
      releaseTouchDrag();
      if (pointerSequenceConsumed) {
        if (pointers.size === 0) pointerSequenceConsumed = false;
        return;
      }
      if (pointers.size === 0) {
        if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
        pendingPointerDx = 0;
        pendingPointerDy = 0;
        if (scrollFrame !== 0 || scrollActive) endScroll(false);
        finishGesture("cancelled");
      }
    };

    const wheel = (event: WheelEvent) => {
      // The tile owns its wheel: a trackpad pinch (ctrl-wheel) zooms about the
      // cursor, a plain scroll pans when zoomed. Either way the page must not
      // scroll out from under the gesture.
      event.preventDefault();
      // The puck means "scrolling", whichever pointer is driving it, so an engaged puck sends the
      // wheel to the far Mac instead of panning the local picture. It reuses the finger's phase
      // protocol and its `endScroll`, and differs only where a wheel genuinely differs: its delta
      // needs no curve and its end has to be inferred. A pinch stays local, being a view gesture.
      if (scrollEngagedRef.current && !event.ctrlKey && !event.metaKey) {
        // A wheel delta points where the content is pushed away; the wire carries finger deltas,
        // which point where the content follows. Same negation the local pan below uses.
        const dx = -event.deltaX;
        const dy = -event.deltaY;
        if (dx === 0 && dy === 0) return;
        // Leftover momentum from a finger belongs to a gesture this wheel just replaced.
        if (wheelIdleTimer === 0) stopMomentum(true);
        sendWheelScroll(dx, dy);
        armWheelIdle();
        return;
      }
      const { w, h } = size();
      const at = local(event);
      let moved = false;
      if (event.ctrlKey || event.metaKey) {
        moved = view.zoomAt(Math.exp(-event.deltaY * 0.01), at.x, at.y, w, h);
      } else if (view.isZoomed()) {
        moved = view.panBy(-event.deltaX, -event.deltaY, w, h);
      }
      apply();
      if (moved) scheduleSettle();
    };

    const puckDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!puck || puckPointer) return;
      try {
        puck.setPointerCapture(event.pointerId);
      } catch {
        // A lost capture only ends the drag early; the control remains on screen.
      }
      puckPointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragged: false,
      };
    };
    const puckMove = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!puckPointer || puckPointer.id !== event.pointerId) return;
      const crossedSlop = !puckPointer.dragged
        && Math.hypot(
          event.clientX - puckPointer.startX,
          event.clientY - puckPointer.startY,
        ) >= SCROLL_SLOP;
      if (crossedSlop) {
        puckPointer.dragged = true;
      }
      // UIPanGestureRecognizer's first changed callback carries the complete translation that
      // crossed recognition slop. Preserve that initial travel instead of swallowing it.
      const dx = event.clientX - (crossedSlop ? puckPointer.startX : puckPointer.lastX);
      const dy = event.clientY - (crossedSlop ? puckPointer.startY : puckPointer.lastY);
      puckPointer.lastX = event.clientX;
      puckPointer.lastY = event.clientY;
      if (!puckPointer.dragged || (dx === 0 && dy === 0)) return;
      puckOffset = { right: puckOffset.right - dx, bottom: puckOffset.bottom - dy };
      applyPuckOffset(true);
    };
    const finishPuckPointer = (event: PointerEvent, cancelled: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      if (!puckPointer || puckPointer.id !== event.pointerId) return;
      const completed = puckPointer;
      puckPointer = null;
      if (cancelled || completed.dragged) return;
      const now = performance.now();
      const isDoubleTap = now - lastPuckTapAt <= 300
        && Math.hypot(event.clientX - lastPuckTapX, event.clientY - lastPuckTapY) <= 24;
      if (isDoubleTap) {
        if (pendingPuckTap !== 0) window.clearTimeout(pendingPuckTap);
        pendingPuckTap = 0;
        lastPuckTapAt = Number.NEGATIVE_INFINITY;
        toggleZoomAtPointer();
        return;
      }
      lastPuckTapAt = now;
      lastPuckTapX = event.clientX;
      lastPuckTapY = event.clientY;
      if (pendingPuckTap !== 0) window.clearTimeout(pendingPuckTap);
      pendingPuckTap = window.setTimeout(() => {
        pendingPuckTap = 0;
        setScrollEngaged(!scrollEngagedRef.current);
      }, 300);
    };
    const puckUp = (event: PointerEvent) => finishPuckPointer(event, false);
    const puckCancel = (event: PointerEvent) => finishPuckPointer(event, true);
    const handleResize = () => {
      const { w, h } = size();
      if (keyboardPresentedRef.current) {
        // The keyboard leaves a strip, and `object-contain` would spend most of it on black bars
        // around a shrunken desktop. Fill the strip instead and aim it at the cursor, which is
        // where the typing is going. Recomputed on every resize while typing so an accessory that
        // changes height re-aims rather than drifting.
        if (viewBeforeKeyboard === null) viewBeforeKeyboard = view.snapshot();
        view.cover(remoteCursor, w, h);
      } else if (viewBeforeKeyboard !== null) {
        // The cover was this viewer's doing, not the user's, so leaving the keyboard leaves it.
        view.restore(viewBeforeKeyboard, w, h);
        viewBeforeKeyboard = null;
      } else {
        // Clamping, not just re-applying: a shorter box narrows the legal range, so a pan that
        // was legal at the old height can now pull the content's bottom edge inside the viewport
        // and show black.
        view.reclamp(w, h);
      }
      scheduleSettle();
      applyPuckOffset(false);
      apply();
    };

    frame.addEventListener("pointerdown", down);
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", cancel);
    window.addEventListener("resize", handleResize);
    // The window listener alone is not enough: the viewer shortens this box for the keyboard
    // accessory, which changes no window dimension and would otherwise leave the transform and the
    // cursor overlay measured against a viewport that no longer exists.
    const frameResize = new ResizeObserver(handleResize);
    frameResize.observe(frame);
    puck?.addEventListener("pointerdown", puckDown);
    puck?.addEventListener("pointermove", puckMove);
    puck?.addEventListener("pointerup", puckUp);
    puck?.addEventListener("pointercancel", puckCancel);
    // Non-passive on purpose: preventDefault on a wheel only works that way.
    frame.addEventListener("wheel", wheel, { passive: false });
    const unsubscribeCursorEvents = subscribeCursorEvents?.(applyCursorEvent);
    applyPuckOffset(false);
    apply();
    return () => {
      frame.removeEventListener("pointerdown", down);
      frame.removeEventListener("pointermove", move);
      if (settleTimer !== 0) window.clearTimeout(settleTimer);
      stopWatchingCrop();
      stopWatchingOverview();
      view.dispose(layers);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", cancel);
      frame.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", handleResize);
      frameResize.disconnect();
      puck?.removeEventListener("pointerdown", puckDown);
      puck?.removeEventListener("pointermove", puckMove);
      puck?.removeEventListener("pointerup", puckUp);
      puck?.removeEventListener("pointercancel", puckCancel);
      unsubscribeCursorEvents?.();
      if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
      if (wheelIdleTimer !== 0) window.clearTimeout(wheelIdleTimer);
      if (scrollFrame !== 0 || scrollActive) endScroll(false);
      stopMomentum(true);
      if (pendingPuckTap !== 0) window.clearTimeout(pendingPuckTap);
      cancelTouchHold();
      releaseTouchDrag();
      releaseMouseButton();
    };
  }, [
    initialCursor?.x,
    initialCursor?.y,
    pointerMode,
    sourceHeight,
    sourceWidth,
    subscribeCursorEvents,
    zoomMode,
    overviewLayer,
  ]);

  return (
    <div
      ref={viewport}
      data-desktop-viewport=""
      className={`relative overflow-hidden select-none ${className}`}
      style={{ touchAction: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
    >
      {/* Underneath, so the sharp picture above it wins wherever both are drawn. */}
      <div ref={underlayContent} className="absolute inset-0">
        {underlay}
      </div>
      <div ref={content} className="h-full origin-top-left will-change-transform">
        {children}
      </div>
      {pointerMode ? (
        <button
          ref={scrollPuck}
          type="button"
          data-testid="pointer-scroll-puck"
          aria-label="Scroll clutch"
          aria-pressed={scrollEngaged}
          title={scrollEngaged
            ? "Scrolling: one finger scrolls at the parked pointer"
            : "Pointer: tap to make one finger scroll"}
          onClick={(event) => {
            // Keyboard and assistive-technology activation has detail=0. Physical pointers are
            // arbitrated by the delayed single/double-tap state machine installed above.
            if (event.detail === 0) setScrollEngaged(!scrollEngagedRef.current);
          }}
          style={{
            right: DEFAULT_POINTER_SCROLL_PUCK_OFFSET.right,
            bottom: `max(${DEFAULT_POINTER_SCROLL_PUCK_OFFSET.bottom}px, var(--desktop-chrome-clearance, 0px))`,
            // Hidden, never unmounted, while typing. The puck's own pointer listeners are
            // bound once by the layout effect above, whose deps do not include the keyboard;
            // a remounted puck comes back deaf, and its taps then fall through to the tile as
            // a remote click that re-arms the keyboard instead of toggling the clutch.
            ...(keyboardPresented ? { display: "none" } : {}),
          }}
          className={`absolute z-20 grid size-14 touch-none select-none place-items-center rounded-full border bg-black/45 text-white shadow-md transition-[opacity,transform,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black/70 active:scale-95 motion-reduce:transition-none ${
            scrollEngaged
              ? "border-blue-400/90 opacity-90 hover:opacity-100"
              : "border-white/35 opacity-35 hover:opacity-65 focus-visible:opacity-100"
          }`}
        >
          {scrollEngaged ? (
            <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
              <path
                d="M12 2v20M2 12h20M8.5 5.5 12 2l3.5 3.5M8.5 18.5 12 22l3.5-3.5M5.5 8.5 2 12l3.5 3.5M18.5 8.5 22 12l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
              <path
                d="M5 3v15l4.2-4.2 3.2 7.2 2.6-1.2-3.2-7.1H18L5 3Z"
                fill="currentColor"
                stroke="black"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      ) : null}
      <div
        ref={cursorOverlay}
        data-testid="client-cursor-overlay"
        className="pointer-events-none absolute left-0 top-0 size-0 will-change-transform"
        aria-hidden="true"
      >
        <span
          ref={dragHalo}
          hidden
          data-testid="client-drag-halo"
          className="absolute -left-2.5 -top-2.5 size-5 rounded-full border-2 border-blue-400 bg-blue-400/25"
        />
        <span
          ref={dragPriming}
          hidden
          data-testid="client-drag-priming"
          className="absolute -left-3.5 -top-3.5 size-7"
        >
          <svg viewBox="0 0 28 28" className="size-full -rotate-90" aria-hidden="true">
            <circle
              cx="14"
              cy="14"
              r={DRAG_PRIMING_RADIUS}
              strokeWidth="2.5"
              className="fill-black/25 stroke-white/40"
            />
            <circle
              ref={dragPrimingArc}
              cx="14"
              cy="14"
              r={DRAG_PRIMING_RADIUS}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={DRAG_PRIMING_CIRCUMFERENCE}
              strokeDashoffset={DRAG_PRIMING_CIRCUMFERENCE}
              className="fill-none stroke-blue-400"
            />
          </svg>
        </span>
        <svg
          ref={cursorFallback}
          data-testid="client-cursor-fallback"
          viewBox="0 0 11 18"
          className="h-3 w-2 max-w-none overflow-visible"
          aria-hidden="true"
        >
          <path
            d="M0 0v16l4-4 3 6 2-0.8-3-6L11 11Z"
            className="fill-none stroke-blue-500 stroke-[4] [stroke-linejoin:round]"
          />
          <path
            d="M0 0v16l4-4 3 6 2-0.8-3-6L11 11Z"
            className="fill-white stroke-black stroke-[1.2] [stroke-linejoin:round]"
          />
        </svg>
        <img
          ref={cursorImage}
          alt=""
          hidden
          draggable={false}
          className="absolute left-0 top-0 max-w-none drop-shadow-[0_0_7px_var(--color-blue-500)]"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
