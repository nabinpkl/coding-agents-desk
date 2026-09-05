// The two ways the viewer can zoom, behind one interface so the gesture code does not care which.
//
// `css` is the model the viewer has always had: the picture of the whole display, magnified with
// a transform. `crop` is the DeskZoom viewer's: the state is which part of the display is on
// screen, the capture is re-aimed at it, and the frame is placed geometrically. They are kept
// side by side, switchable at runtime, so they can be compared on the same desk.

import { getCaptureCrop, setCaptureCrop } from "./captureCrop";
import {
  MAX_PIXELS_PER_POINT,
  capturePlanFor,
  planServes,
  wantedPixelsPerPoint,
  type CapturePlan,
} from "./tileCapturePlan";
import {
  IDENTITY,
  clampPan,
  coverOnRemoteCursor,
  followRemoteCursor,
  panBy,
  projectRemoteCursor,
  unprojectRemoteCursor,
  zoomAt,
  type ViewportPoint,
  type ViewportTransform,
} from "./tileViewportMath";
import {
  centreVisible,
  clampVisible,
  fitRect,
  followVisible,
  isWholeDisplay,
  largestFitting,
  magnification,
  panVisible,
  placeRegion,
  projectPoint,
  unprojectPoint,
  wholeDisplay,
  zoomVisible,
  type DisplayRect,
  type DisplaySize,
} from "./visibleRect";
import type { ZoomMode } from "./zoomMode";

/** How close to the edge the remote cursor may get before the view pans, as a fraction of it. DeskZoom's value. */
const FOLLOW_MARGIN = 0.18;

export interface ZoomView {
  readonly kind: ZoomMode;
  /** Each returns whether the view actually changed. */
  zoomAt(factor: number, cx: number, cy: number, w: number, h: number): boolean;
  panBy(dx: number, dy: number, w: number, h: number): boolean;
  reset(): void;
  isZoomed(): boolean;
  /** Keep the remote cursor inside the edge band; true when the view moved to do so. */
  follow(cursor: ViewportPoint, w: number, h: number): boolean;
  /** Fill the strip above the keyboard and aim it at the cursor. */
  cover(cursor: ViewportPoint, w: number, h: number): void;
  /** The view to put back when the keyboard goes, and putting it back. */
  snapshot(): unknown;
  restore(snapshot: unknown, w: number, h: number): void;
  /** The viewport changed size; keep the view legal for the new one. */
  reclamp(w: number, h: number): void;
  project(cursor: ViewportPoint, w: number, h: number): ViewportPoint | null;
  unproject(point: ViewportPoint, w: number, h: number): ViewportPoint | null;
  /** Put the view onto the content element. */
  paint(inner: HTMLElement, w: number, h: number): void;
  /** The gesture has settled: ask for a capture if the running one no longer serves the view. */
  settle(w: number, h: number): void;
  /** A stream's first frame arrived: the frame on screen now covers this plan's region. */
  applied(plan: CapturePlan | null): void;
  telemetry(): { scale: number; tx: number; ty: number };
  /** Leave the content element as it was found. */
  dispose(inner: HTMLElement): void;
}

export function createZoomView(mode: ZoomMode, display: DisplaySize): ZoomView {
  return mode === "crop" ? cropZoomView(display) : cssZoomView(display);
}

function cssZoomView(display: DisplaySize): ZoomView {
  let transform: ViewportTransform = IDENTITY;
  const changed = (next: ViewportTransform) => {
    const moved = next.scale !== transform.scale || next.tx !== transform.tx || next.ty !== transform.ty;
    transform = next;
    return moved;
  };
  return {
    kind: "css",
    zoomAt: (factor, cx, cy, w, h) => changed(zoomAt(transform, factor, cx, cy, w, h)),
    panBy: (dx, dy, w, h) => changed(panBy(transform, dx, dy, w, h)),
    reset: () => { transform = IDENTITY; },
    isZoomed: () => transform.scale > 1,
    follow: (cursor, w, h) =>
      changed(followRemoteCursor(transform, cursor, display.width, display.height, w, h)),
    cover: (cursor, w, h) => {
      transform = coverOnRemoteCursor(cursor, display.width, display.height, w, h);
    },
    snapshot: () => transform,
    restore: (snapshot, w, h) => { transform = clampPan(snapshot as ViewportTransform, w, h); },
    reclamp: (w, h) => { transform = clampPan(transform, w, h); },
    project: (cursor, w, h) => projectRemoteCursor(transform, cursor, display.width, display.height, w, h),
    unproject: (point, w, h) => unprojectRemoteCursor(transform, point, display.width, display.height, w, h),
    paint: (inner) => {
      inner.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
    },
    settle: () => {},
    applied: () => {},
    telemetry: () => ({ scale: transform.scale, tx: transform.tx, ty: transform.ty }),
    dispose: (inner) => { inner.style.transform = ""; },
  };
}

function cropZoomView(display: DisplaySize): ZoomView {
  let visible: DisplayRect = wholeDisplay(display);
  /** What the frame on screen covers. The whole display until a plan's first frame says otherwise. */
  let region: DisplayRect = getCaptureCrop()?.region ?? wholeDisplay(display);
  /**
   * A plan has been requested and its first frame has not arrived. One re-aim in flight at a
   * time, as in DeskZoom's applyCaptureUpdate: a second request during a negotiation would tear
   * the first down before it painted, and a capture racing another's teardown is the one thing
   * ScreenCaptureKit is known to starve on. The viewport settles again once the plan lands, so a
   * view that moved meanwhile is served then.
   */
  let awaitingApply = false;

  // The box is `visible` fitted to the viewport: the whole viewport while there is more display
  // to show, the letterbox only once all of it is showing.
  const box = (w: number, h: number): DisplayRect => fitRect(visible, w, h);
  const centre = () => ({ x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 });
  /** Re-shape to the viewport at the same area: what a resize, or a restore, has to do. */
  const reshape = (w: number, h: number) => {
    visible = zoomVisible(visible, display, 1, centre(), { width: w, height: h });
  };
  const changed = (next: DisplayRect) => {
    const moved = next.x !== visible.x || next.y !== visible.y || next.width !== visible.width;
    visible = next;
    return moved;
  };
  const anchorAt = (cx: number, cy: number, w: number, h: number) =>
    unprojectPoint({ x: cx, y: cy }, visible, box(w, h), display) ?? { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
  const pointsPerPixel = (w: number, h: number) => {
    const content = box(w, h);
    return content.width > 0 ? visible.width / content.width : 0;
  };

  return {
    kind: "crop",
    zoomAt: (factor, cx, cy, w, h) =>
      changed(zoomVisible(visible, display, factor, anchorAt(cx, cy, w, h), { width: w, height: h })),
    // Gesture deltas arrive in viewport pixels; the view moves the other way in display points.
    panBy: (dx, dy, w, h) => {
      const k = pointsPerPixel(w, h);
      return changed(panVisible(visible, display, -dx * k, -dy * k));
    },
    reset: () => { visible = wholeDisplay(display); },
    isZoomed: () => !isWholeDisplay(visible, display),
    follow: (cursor) => changed(followVisible(visible, display, cursor, FOLLOW_MARGIN)),
    cover: (cursor, w, h) => {
      // The strip above the keyboard is just a viewport of another aspect. Show the most of the
      // display that fills it, centred on the cursor, which is where the typing is going.
      const size = largestFitting(display, w / h);
      visible = centreVisible({ x: 0, y: 0, ...size }, display, cursor);
    },
    snapshot: () => visible,
    restore: (snapshot, w, h) => {
      visible = clampVisible(snapshot as DisplayRect, display);
      reshape(w, h);
    },
    // A resize changes the viewport's aspect, and a rect shaped to the old one would sit
    // letterboxed in the new: re-shape at the same area rather than merely re-clamp.
    reclamp: (w, h) => reshape(w, h),
    project: (cursor, w, h) => projectPoint(cursor, visible, box(w, h)),
    unproject: (point, w, h) => unprojectPoint(point, visible, box(w, h), display),
    paint: (inner, w, h) => {
      // DeskZoom's placeContent: the frame covers `region`, the view shows `visible`, and the
      // element is put where those agree. The viewport clips whatever the frame holds beyond it.
      const placed = placeRegion(region, visible, box(w, h));
      inner.style.transform = "";
      inner.style.position = "absolute";
      inner.style.left = `${placed.x}px`;
      inner.style.top = `${placed.y}px`;
      inner.style.width = `${placed.width}px`;
      inner.style.height = `${placed.height}px`;
    },
    settle: (w, h) => {
      if (awaitingApply) return;
      const before = getCaptureCrop();
      if (isWholeDisplay(visible, display)) {
        setCaptureCrop(null);
      } else {
        const content = box(w, h);
        const viewportPixels = content.width * Math.min(window.devicePixelRatio || 1, 3);
        const wanted = wantedPixelsPerPoint(visible.width, viewportPixels, MAX_PIXELS_PER_POINT);
        if (planServes(before, visible, wanted)) return;
        setCaptureCrop(capturePlanFor(visible, display.width, display.height, viewportPixels, MAX_PIXELS_PER_POINT));
      }
      // Only a change is in flight; an equal plan never left the store and nothing will answer it.
      awaitingApply = getCaptureCrop() !== before;
    },
    applied: (plan) => {
      awaitingApply = false;
      region = plan?.region ?? wholeDisplay(display);
    },
    telemetry: () => ({ scale: magnification(visible, display), tx: visible.x, ty: visible.y }),
    dispose: (inner) => {
      for (const key of ["position", "left", "top", "width", "height", "transform"] as const) {
        inner.style[key] = "";
      }
    },
  };
}
