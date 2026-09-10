"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import {
  advanceRemoteCursor,
  pointerAccelerationGain,
  scrollAccelerationGain,
  type ViewportPoint,
} from "@/features/desktop-viewer/tile-viewport/tileViewportMath";
import { createZoomView, type SettleOutcome, type ViewLayers } from "@/features/desktop-viewer/zoom/zoomModels";
import { getCaptureCrop, onCaptureCropApplied, onOverviewReady, setCaptureCrop } from "@/features/desktop-viewer/zoom/captureCrop";
import { useZoomMode } from "@/features/desktop-viewer/zoom/zoomMode";
import { useOverviewLayer } from "@/features/desktop-viewer/zoom/overviewLayer";
import { CursorImageCache } from "@/features/desktop-viewer/tile-viewport/cursorImageCache";
import { createCursorMirror } from "@/features/desktop-viewer/tile-viewport/tileViewportCursorMirror";
import { createDragVisuals } from "@/features/desktop-viewer/tile-viewport/tileViewportDragVisuals";
import { createGestureTelemetry } from "@/features/desktop-viewer/tile-gestures/tileViewportGestureTelemetry";
import { createPointerHandlers } from "@/features/desktop-viewer/tile-gestures/tileViewportPointerHandlers";
import { createPuckHandlers } from "@/features/desktop-viewer/tile-gestures/tileViewportPuck";
import type { ViewportRuntime } from "@/features/desktop-viewer/tile-viewport/tileViewportRuntime";
import { createScrolling } from "@/features/desktop-viewer/tile-gestures/tileViewportScrolling";
import { CursorOverlay, PointerScrollPuck } from "@/features/desktop-viewer/tile-viewport/TileViewportOverlays";
import { createFrameGeometry } from "@/features/desktop-viewer/tile-viewport/tileViewportFrame";

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
    const ctx = {
      absolutePointerRef,
      acknowledgedCursorRevision,
      beforeRemoteClickRef,
      cursorImageCache,
      cursorRevision,
      dragHalo,
      dragPriming,
      dragPrimingArc,
      gestureTelemetryRef,
      keyboardPresentedRef,
      pointerGestureStartRef,
      pointerMode,
      scrollEngagedRef,
      sendPointerInputRef,
      setScrollEngaged,
      sourceHeight,
      sourceWidth,
    } as ViewportRuntime;
    // Narrowed together below; the effect returns early when any of them is missing.
    ctx.frame = viewport.current!;
    ctx.inner = content.current!;
    ctx.puck = scrollPuck.current;
    ctx.overlay = cursorOverlay.current!;
    ctx.fallback = cursorFallback.current!;
    ctx.image = cursorImage.current!;
    if (!ctx.frame || !ctx.inner || !ctx.overlay || !ctx.fallback || !ctx.image) return undefined;
    if (!pointerMode && scrollEngagedRef.current) setScrollEngaged(false);

    ctx.layers = { content: ctx.inner, underlay: underlayContent.current } as ViewLayers;
    // A plan the previous display's view settled after the switch is a request for the wrong
    // screen; the streams beneath would send it to the new one.
    if (zoomMode === "crop") {
      const stored = getCaptureCrop();
      if (stored && (stored.display.width !== sourceWidth || stored.display.height !== sourceHeight)) {
        setCaptureCrop(null);
      }
    }
    ctx.view = createZoomView(
      zoomMode,
      { width: sourceWidth, height: sourceHeight },
      { overview: zoomMode === "crop" && overviewLayer },
    );
    /** The view to put back when the keyboard stops occluding the box, or null when it is not. */
    ctx.viewBeforeKeyboard = null;
    ctx.remoteCursor = advanceRemoteCursor(
      initialCursor ?? { x: sourceWidth / 2, y: sourceHeight / 2 },
      0,
      0,
      sourceWidth,
      sourceHeight,
    );
    ctx.cursorHidden = false;
    ctx.pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
    ctx.lastTapAt = 0;
    ctx.lastTapX = 0;
    ctx.lastTapY = 0;
    ctx.didCrossPointerSlop = false;
    ctx.hadMultiplePointers = false;
    ctx.pressedMouseButton = null;
    ctx.touchHoldTimer = 0;
    ctx.touchPrimingTimer = 0;
    ctx.touchPrimingArc = null;
    ctx.touchDragHeld = false;
    ctx.pendingPointerDx = 0;
    ctx.pendingPointerDy = 0;
    ctx.pointerFrame = 0;
    ctx.lastPointerFrameAt = performance.now();
    ctx.pendingScrollDx = 0;
    ctx.pendingScrollDy = 0;
    ctx.scrollFrame = 0;
    ctx.scrollActive = false;
    ctx.lastScrollFrameAt = performance.now();
    ctx.lastScrollSampleAt = performance.now();
    ctx.lastScrollVelocity = { x: 0, y: 0 };
    ctx.momentumFrame = 0;
    ctx.momentumLastTime = 0;
    ctx.momentumVelocity = { x: 0, y: 0 };
    ctx.didEmitMomentumBegan = false;
    ctx.wheelIdleTimer = 0;
    ctx.puckOffset = storedPointerScrollPuckOffset();
    ctx.puckPointer = null;
    ctx.lastPuckTapAt = Number.NEGATIVE_INFINITY;
    ctx.lastPuckTapX = 0;
    ctx.lastPuckTapY = 0;
    ctx.pendingPuckTap = 0;
    ctx.activeGesture = null;
    ctx.gestureInputAccepted = true;
    ctx.gestureTransformed = false;
    ctx.gestureEdgeFollowed = false;
    ctx.pointerSequenceConsumed = false;
    ctx.settleTimer = 0;
    ctx.lastReaimAt = Number.NEGATIVE_INFINITY;
    Object.assign(ctx, createFrameGeometry(ctx));

    // A requested plan is now on screen: the frame covers its region, so place it by that. Then
    // settle again, because the view may have moved while that plan was being negotiated and the
    // model holds one re-aim at a time; if it did not move, the plan serves and nothing happens.
    const stopWatchingCrop = onCaptureCropApplied((plan) => {
      ctx.view.applied(plan);
      ctx.apply();
      ctx.scheduleSettle();
    });
    // The overview has painted: a sharp request that was waiting on it can go out now.
    const stopWatchingOverview = onOverviewReady(() => ctx.scheduleSettle());
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

    // Staged, because the parts call each other: a press asks the gesture telemetry to
    // open, the cursor mirror to warp and the scrolling to end, and none of those exists
    // until its own factory has run. Every call happens at event time, by which point all
    // of them are on `ctx`.
    Object.assign(ctx, createGestureTelemetry(ctx));
    Object.assign(ctx, createDragVisuals(ctx));
    Object.assign(ctx, createCursorMirror(ctx));
    Object.assign(ctx, createScrolling(ctx));
    Object.assign(ctx, createPointerHandlers(ctx));
    Object.assign(ctx, createPuckHandlers(ctx));
    // The window listener alone is not enough: the viewer shortens this box for the keyboard
    // accessory, which changes no window dimension and would otherwise leave the transform and the
    // cursor overlay measured against a viewport that no longer exists.

    ctx.frame.addEventListener("pointerdown", ctx.down);
    ctx.frame.addEventListener("pointermove", ctx.move);
    ctx.frame.addEventListener("pointerup", ctx.up);
    ctx.frame.addEventListener("pointercancel", ctx.cancel);
    window.addEventListener("resize", ctx.handleResize);
    const frameResize = new ResizeObserver(ctx.handleResize);
    frameResize.observe(ctx.frame);
    ctx.puck?.addEventListener("pointerdown", ctx.puckDown);
    ctx.puck?.addEventListener("pointermove", ctx.puckMove);
    ctx.puck?.addEventListener("pointerup", ctx.puckUp);
    ctx.puck?.addEventListener("pointercancel", ctx.puckCancel);
    // Non-passive on purpose: preventDefault on a wheel only works that way.
    ctx.frame.addEventListener("wheel", ctx.wheel, { passive: false });
    const unsubscribeCursorEvents = subscribeCursorEvents?.(ctx.applyCursorEvent);
    ctx.applyPuckOffset(false);
    ctx.apply();
    return () => {
      ctx.frame.removeEventListener("pointerdown", ctx.down);
      ctx.frame.removeEventListener("pointermove", ctx.move);
      if (ctx.settleTimer !== 0) window.clearTimeout(ctx.settleTimer);
      stopWatchingCrop();
      stopWatchingOverview();
      ctx.view.dispose(ctx.layers);
      ctx.frame.removeEventListener("pointerup", ctx.up);
      ctx.frame.removeEventListener("pointercancel", ctx.cancel);
      ctx.frame.removeEventListener("wheel", ctx.wheel);
      window.removeEventListener("resize", ctx.handleResize);
      frameResize.disconnect();
      ctx.puck?.removeEventListener("pointerdown", ctx.puckDown);
      ctx.puck?.removeEventListener("pointermove", ctx.puckMove);
      ctx.puck?.removeEventListener("pointerup", ctx.puckUp);
      ctx.puck?.removeEventListener("pointercancel", ctx.puckCancel);
      unsubscribeCursorEvents?.();
      if (ctx.pointerFrame !== 0) window.cancelAnimationFrame(ctx.pointerFrame);
      if (ctx.wheelIdleTimer !== 0) window.clearTimeout(ctx.wheelIdleTimer);
      if (ctx.scrollFrame !== 0 || ctx.scrollActive) ctx.endScroll(false);
      ctx.stopMomentum(true);
      if (ctx.pendingPuckTap !== 0) window.clearTimeout(ctx.pendingPuckTap);
      ctx.cancelTouchHold();
      ctx.releaseTouchDrag();
      ctx.releaseMouseButton();
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
        <PointerScrollPuck
          keyboardPresented={keyboardPresented}
          scrollEngaged={scrollEngaged}
          scrollEngagedRef={scrollEngagedRef}
          scrollPuck={scrollPuck}
          setScrollEngaged={setScrollEngaged}
        />
      ) : null}
      <CursorOverlay
        cursorFallback={cursorFallback}
        cursorImage={cursorImage}
        cursorOverlay={cursorOverlay}
        dragHalo={dragHalo}
        dragPriming={dragPriming}
        dragPrimingArc={dragPrimingArc}
      />
    </div>
  );
}
