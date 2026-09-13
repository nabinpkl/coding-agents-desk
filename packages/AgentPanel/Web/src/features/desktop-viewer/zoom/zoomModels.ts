// The two ways the viewer can zoom, behind one interface so the gesture code does not care which.
//
// `css` is the model the viewer has always had: the picture of the whole display, magnified with
// a transform. `crop` is the DeskZoom viewer's: the state is which part of the display is on
// screen, the capture is re-aimed at it, and the frame is placed geometrically. They are kept
// side by side, switchable at runtime, so they can be compared on the same desk.

import { getCaptureCrop, overviewReady, setCaptureCrop } from "./captureCrop";
import {
  CAPTURE_PADDING,
  MAX_PIXELS_PER_POINT,
  capturePlanFor,
  leadPadding,
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
} from "../tile-viewport/tileViewportMath";
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
  regionCovers,
  unprojectPoint,
  wholeDisplay,
  zoomVisible,
  type DisplayRect,
  type DisplaySize,
} from "./visibleRect";
import type { ZoomMode } from "./zoomMode";

/** How close to the edge the remote cursor may get before the view pans, as a fraction of it. DeskZoom's value. */
const FOLLOW_MARGIN = 0.18;
/** A pan this recent still says which way the view is going when the capture is re-aimed. */
const PAN_LEAD_WINDOW_MS = 400;
/** How long the overview must have been painting before a sharp capture is asked for beside it. */
const OVERVIEW_HEAD_START_MS = 300;
/** Ask for a sharp capture only once the view wants this much more detail than the overview has. */
const DETAIL_OVER_OVERVIEW = 1.08;
/**
 * How long a requested plan may stay unanswered before the view may ask for another.
 *
 * A local capture answers in one frame; a stream to a phone answers in a second or two, and
 * sometimes not at all. Past this the view is free to re-aim, which is what it wants anyway: the
 * only settle that reaches here is one the running region no longer serves.
 */
const PLAN_APPLY_TIMEOUT_MS = 2_500;

/** The elements a view paints: the sharp picture, and the coarse one underneath it when there is one. */
export interface ViewLayers {
  readonly content: HTMLElement;
  readonly underlay: HTMLElement | null;
}

export interface ZoomViewOptions {
  /** A coarse whole-display stream is running under the sharp one. Crop mode only. */
  readonly overview?: boolean;
}

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
  /** Put the view onto the layers. */
  paint(layers: ViewLayers, w: number, h: number): void;
  /** The gesture has settled: ask for a capture if the running one no longer serves the view. */
  settle(w: number, h: number): SettleOutcome;
  /** A stream's first frame arrived: the frame on screen now covers this plan's region. */
  applied(plan: CapturePlan | null): void;
  telemetry(): { scale: number; tx: number; ty: number };
  /** Leave the elements as they were found. */
  dispose(layers: ViewLayers): void;
}

export function createZoomView(mode: ZoomMode, display: DisplaySize, options: ZoomViewOptions = {}): ZoomView {
  return mode === "crop" ? cropZoomView(display, options.overview === true) : cssZoomView(display);
}

const PLACED_STYLES = ["position", "left", "top", "width", "height", "transform", "visibility"] as const;
function clearPlaced(element: HTMLElement | null) {
  if (!element) return;
  for (const key of PLACED_STYLES) element.style[key] = "";
}
function place(element: HTMLElement, rect: DisplayRect, shown: boolean) {
  element.style.transform = "";
  element.style.position = "absolute";
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  element.style.visibility = shown ? "" : "hidden";
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
    paint: ({ content, underlay }) => {
      content.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
      if (underlay) underlay.style.visibility = "hidden";
    },
    settle: () => ({ outcome: "css" }),
    applied: () => {},
    telemetry: () => ({ scale: transform.scale, tx: transform.tx, ty: transform.ty }),
    dispose: ({ content, underlay }) => {
      content.style.transform = "";
      if (underlay) underlay.style.visibility = "";
    },
  };
}

/** What a settle decided, for the diagnostics log: the one place a phone's view can be read from. */
export interface SettleOutcome {
  outcome: "css" | "awaiting" | "whole" | "overview-serves" | "overview-not-ready" | "served" | "planned";
  visible?: { x: number; y: number; w: number; h: number };
  viewportPixels?: number;
  wanted?: number;
  overviewDetail?: number;
  plan?: string | null;
}

/** The stored plan if it was made for this display, else null. */
function planFor(display: DisplaySize, plan: CapturePlan | null): CapturePlan | null {
  if (!plan) return null;
  return plan.display.width === display.width && plan.display.height === display.height ? plan : null;
}

function cropZoomView(display: DisplaySize, overview: boolean): ZoomView {
  let visible: DisplayRect = wholeDisplay(display);
  /** What the frame on screen covers. The whole display until a plan's first frame says otherwise. */
  let region: DisplayRect = planFor(display, getCaptureCrop())?.region ?? wholeDisplay(display);
  /**
   * A plan has been requested and its first frame has not arrived. One re-aim in flight at a
   * time, as in DeskZoom's applyCaptureUpdate: a second request during a negotiation would tear
   * the first down before it painted, and a capture racing another's teardown is the one thing
   * ScreenCaptureKit is known to starve on. The viewport settles again once the plan lands, so a
   * view that moved meanwhile is served then.
   */
  let awaitingApply = false;
  /** When the plan now in flight was asked for, so a stream that never paints cannot freeze the view. */
  let awaitingSince = 0;
  /** The last movement of the view, in display points, so a re-aim can lead it. */
  let lastPan: { x: number; y: number; at: number } | null = null;
  const moved = (next: DisplayRect) => {
    if (next.x !== visible.x || next.y !== visible.y) {
      lastPan = { x: next.x - visible.x, y: next.y - visible.y, at: performance.now() };
    }
    return changed(next);
  };

  // The box is `visible` fitted to the viewport: the whole viewport while there is more display
  // to show, the letterbox only once all of it is showing.
  const box = (w: number, h: number): DisplayRect => fitRect(visible, w, h);
  const centre = () => ({ x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 });
  /** Re-shape to the viewport at the same area: what a resize, or a restore, has to do. */
  const reshape = (w: number, h: number) => {
    // The whole display is already the one view that does not take the viewport's aspect; re-shaping
    // it would zoom into a slice of itself on every resize.
    if (isWholeDisplay(visible, display)) return;
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
      return moved(panVisible(visible, display, -dx * k, -dy * k));
    },
    reset: () => { visible = wholeDisplay(display); },
    isZoomed: () => !isWholeDisplay(visible, display),
    follow: (cursor) => moved(followVisible(visible, display, cursor, FOLLOW_MARGIN)),
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
    paint: ({ content, underlay }, w, h) => {
      // DeskZoom's placeContent: each frame covers a region, the view shows `visible`, and each
      // element is put where those agree; the viewport clips whatever a frame holds beyond it.
      // With the overview underneath, the sharp frame is shown only when it covers all of the
      // view: half sharp and half coarse with the boundary sweeping across is what flicker is.
      // Without one there is nothing else to show, so a partial sharp frame beats bare edge.
      const shown = box(w, h);
      if (underlay) {
        place(underlay, placeRegion(wholeDisplay(display), visible, shown), true);
        place(content, placeRegion(region, visible, shown), regionCovers(region, visible));
      } else {
        place(content, placeRegion(region, visible, shown), true);
      }
    },
    settle: (w, h) => {
      const content = box(w, h);
      const viewportPixels = content.width * Math.min(window.devicePixelRatio || 1, 3);
      const wanted = wantedPixelsPerPoint(visible.width, viewportPixels, MAX_PIXELS_PER_POINT);
      // DeskZoom's needsDetailCapture: while the coarse stream already carries the detail the view
      // can show, a sharp one would only add something to swap to and from while panning.
      const overviewDetail = Math.min(MAX_PIXELS_PER_POINT, viewportPixels / display.width);
      const facts = {
        visible: { x: Math.round(visible.x), y: Math.round(visible.y), w: Math.round(visible.width), h: Math.round(visible.height) },
        viewportPixels: Math.round(viewportPixels),
        wanted: Number(wanted.toFixed(3)),
        overviewDetail: Number(overviewDetail.toFixed(3)),
      };
      const done = (outcome: SettleOutcome["outcome"]): SettleOutcome => {
        const plan = getCaptureCrop();
        return { outcome, ...facts, plan: plan ? `${Math.round(plan.region.x)},${Math.round(plan.region.y)},${Math.round(plan.region.width)},${Math.round(plan.region.height)}@${plan.pixelWidth}x${plan.pixelHeight}` : null };
      };
      // A re-aim in flight blocks the next one, but only for as long as one can plausibly take.
      // A sharp stream that never delivers a frame used to hold the view for its full connection
      // timeout, and a view outside the running region shows the coarse layer for all of it.
      if (awaitingApply && performance.now() - awaitingSince < PLAN_APPLY_TIMEOUT_MS) return done("awaiting");
      const before = getCaptureCrop();
      const servedByOverview = overview && wanted <= overviewDetail * DETAIL_OVER_OVERVIEW;
      let outcome: SettleOutcome["outcome"];
      if (isWholeDisplay(visible, display) || servedByOverview) {
        setCaptureCrop(null);
        outcome = servedByOverview ? "overview-serves" : "whole";
      } else if (overview && !overviewReady(OVERVIEW_HEAD_START_MS)) {
        // Not yet: the sharp capture must not start beside an overview that has not proven it is
        // running. The viewport settles again when it has.
        return done("overview-not-ready");
      } else {
        if (planServes(before, visible, wanted)) return done("served");
        outcome = "planned";
        // Lean the padding the way the view was last going, while that is still recent enough
        // to mean anything; a still view gets it evenly.
        const padding = lastPan && performance.now() - lastPan.at < PAN_LEAD_WINDOW_MS
          ? leadPadding(lastPan)
          : CAPTURE_PADDING;
        setCaptureCrop(capturePlanFor(visible, display.width, display.height, viewportPixels, MAX_PIXELS_PER_POINT, padding));
      }
      // Only a change is in flight; an equal plan never left the store and nothing will answer it.
      // And under an overview, no plan is answered by no stream: the overview is the picture, so
      // there is nothing to wait for. Waiting anyway left the view frozen: every later settle
      // returned early and the sharp stream never came back after a zoom out.
      const after = getCaptureCrop();
      if (overview && after === null) {
        awaitingApply = false;
        region = wholeDisplay(display);
      } else {
        awaitingApply = after !== before;
        if (awaitingApply) awaitingSince = performance.now();
      }
      return done(outcome);
    },
    applied: (plan) => {
      awaitingApply = false;
      region = plan?.region ?? wholeDisplay(display);
    },
    telemetry: () => ({ scale: magnification(visible, display), tx: visible.x, ty: visible.y }),
    dispose: ({ content, underlay }) => {
      clearPlaced(content);
      clearPlaced(underlay);
    },
  };
}
