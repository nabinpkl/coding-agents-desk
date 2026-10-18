"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopPointerInput, WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import type { ViewportPoint } from "@/features/desktop-viewer/tile-viewport/tileViewportMath";
import { storedPointerScrollPuckOffset } from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import {
  usePointerInputSession,
  type PointerInputSession,
} from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { VelocityTracker } from "@/features/desktop-viewer/pointer-input/velocityTracker";
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
import { useLatestRef } from "@/hooks/useLatestRef";

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
  showCursor = false,
  absolutePointer = false,
  sendPointerInput,
  input: providedInput,
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
  /**
   * Draw the Mac's cursor though the picture does not drive it: in Trackpad mode the deck moves
   * the pointer, and the picture is where you watch it go.
   */
  showCursor?: boolean;
  /** Mouse only: put the remote cursor where the pointer is, instead of nudging it by deltas. */
  absolutePointer?: boolean;
  sendPointerInput?: (input: DesktopPointerInput) => boolean;
  /**
   * The viewer's shared pointer input, when something else (the trackpad) drives the same
   * cursor. Without it the viewport makes its own and points it at `sendPointerInput`.
   */
  input?: PointerInputSession;
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
  const input = usePointerInputSession(sendPointerInput, providedInput);
  const pointerGestureStartRef = useLatestRef(onPointerGestureStart);
  const beforeRemoteClickRef = useLatestRef(onBeforeRemoteClick);
  const keyboardPresentedRef = useLatestRef(keyboardPresented);
  const gestureTelemetryRef = useLatestRef(onGestureTelemetry);
  const absolutePointerRef = useLatestRef(absolutePointer);
  const scrollEngagedRef = useRef(false);
  const [scrollEngaged, setScrollEngagedState] = useState(false);

  const setScrollEngaged = (engaged: boolean) => {
    scrollEngagedRef.current = engaged;
    setScrollEngagedState(engaged);
  };

  useLayoutEffect(() => {
    const ctx = {
      absolutePointerRef,
      beforeRemoteClickRef,
      cursorImageCache,
      dragHalo,
      dragPriming,
      dragPrimingArc,
      gestureTelemetryRef,
      keyboardPresentedRef,
      pointerGestureStartRef,
      pointerMode,
      showCursor,
      scrollEngagedRef,
      input,
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
    input.cursor.reset({ width: sourceWidth, height: sourceHeight }, initialCursor);
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
    ctx.scrollVelocity = new VelocityTracker();
    ctx.scrollBegun = false;
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
    const unsubscribeCursor = input.cursor.subscribe(ctx.cursorChanged);
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
      unsubscribeCursor();
      if (ctx.wheelIdleTimer !== 0) window.clearTimeout(ctx.wheelIdleTimer);
      if (ctx.pendingPuckTap !== 0) window.clearTimeout(ctx.pendingPuckTap);
      ctx.cancelTouchHold();
      ctx.releaseTouchDrag();
      ctx.releaseMouseButton();
      // Every phase this viewport could have opened is closed while the transport is still there:
      // a scroll left open or a button left down on the far Mac outlives the page.
      input.translator.dispose();
    };
  }, [
    initialCursor?.x,
    initialCursor?.y,
    pointerMode,
    showCursor,
    sourceHeight,
    sourceWidth,
    subscribeCursorEvents,
    input,
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
