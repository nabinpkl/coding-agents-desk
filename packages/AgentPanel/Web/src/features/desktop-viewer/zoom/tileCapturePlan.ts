/**
 * What to capture, and at what detail, for a given view of a display.
 *
 * Ported from the DeskZoom viewer, which drives an 8K canvas by re-aiming a capture region instead
 * of scaling the whole display down. Three ideas carry over, and each one exists because the naive
 * version misbehaves:
 *
 * - Detail is decided by the VISIBLE area, not by the region captured, and is capped at what the
 *   source actually holds. Asking for more pixels than the display has invents nothing.
 * - The region is PADDED beyond what is visible, so a small pan is still served by the capture
 *   already running. Re-aiming on every movement is what made the desktop crawl.
 * - A plan is kept while it still serves the view. The two directions are deliberately lopsided:
 *   being short of pixels is blurred text, which is the thing being read, so a shortfall re-aims
 *   almost at once, while a surplus only wastes encoder work and is tolerated well past double.
 */
export interface CaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CapturePlan {
  /** The display the plan was made for. A plan outlives a display switch in the store for a
   *  moment; one that names another display's size is stale, not a request. */
  readonly display: { readonly width: number; readonly height: number };
  /** The region to capture, in display points. */
  readonly region: CaptureRegion;
  /** The pixels to capture it at. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/**
 * Detail ceiling, in capture pixels per display point.
 *
 * One, because the desk this exists for is a 1x virtual display: it holds exactly one pixel per
 * point, and asking for more returns an upscale of the same pixels at several times the bitrate.
 * A HiDPI source would raise this, and would need the encoder to report its backing scale first --
 * the answer's metadata carries points only.
 */
export const MAX_PIXELS_PER_POINT = 1;

/** How far beyond the visible region to capture, as a fraction of it. DeskZoom's value. */
export const CAPTURE_PADDING = 0.2;
/** Re-aim once the capture holds less than this share of the detail wanted. */
export const DETAIL_SHORTFALL = 0.92;
/** Tolerate this much more detail than wanted before narrowing. */
export const DETAIL_SURPLUS = 2.2;

/**
 * Capture pixels per display point: what the viewport can actually show, capped at the source's own
 * resolution. A 1x virtual display holds one pixel per point, so on an 8K desk that is the ceiling
 * and zooming past it cannot sharpen anything -- there is no more detail on the display to fetch.
 */
export function wantedPixelsPerPoint(
  visibleWidth: number,
  viewportPixelWidth: number,
  maxPixelsPerPoint: number,
): number {
  if (visibleWidth <= 0) return maxPixelsPerPoint;
  return Math.min(viewportPixelWidth / visibleWidth, maxPixelsPerPoint);
}

/** Padding per side, each a fraction of the visible size on that axis. */
export interface PaddingSides {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Ahead of a pan, as a fraction of the visible size. Costs pixels only on the side that needs them. */
export const LEAD_PADDING = 0.6;
/** Behind a pan. Little, because the view is leaving it. */
export const TRAIL_PADDING = 0.1;

/**
 * Padding that leans in the direction the view is moving.
 *
 * A pan spends symmetric padding in one gesture and then shows the viewport's bare edge until
 * the re-aim lands. Spending the same pixels ahead of the motion instead keeps the edge covered
 * for longer, at no cost behind, where the view is leaving anyway. A stopgap for the absence of a
 * coarse whole-display layer underneath, which is what actually removes the bare edge.
 */
export function leadPadding(
  direction: { x: number; y: number },
  ahead = LEAD_PADDING,
  behind = TRAIL_PADDING,
  base = CAPTURE_PADDING,
): PaddingSides {
  const axis = (v: number): [number, number] =>
    v > 0 ? [behind, ahead] : v < 0 ? [ahead, behind] : [base, base];
  const [left, right] = axis(direction.x);
  const [top, bottom] = axis(direction.y);
  return { left, top, right, bottom };
}

function sides(padding: number | PaddingSides): PaddingSides {
  return typeof padding === "number"
    ? { left: padding, top: padding, right: padding, bottom: padding }
    : padding;
}

/** The padded region, clipped to the display: never asks for points outside it. */
export function paddedRegion(
  visible: CaptureRegion,
  displayWidth: number,
  displayHeight: number,
  padding: number | PaddingSides = CAPTURE_PADDING,
): CaptureRegion {
  const pad = sides(padding);
  const left = Math.max(0, visible.x - visible.width * pad.left);
  const top = Math.max(0, visible.y - visible.height * pad.top);
  const right = Math.min(displayWidth, visible.x + visible.width * (1 + pad.right));
  const bottom = Math.min(displayHeight, visible.y + visible.height * (1 + pad.bottom));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function capturePlanFor(
  visible: CaptureRegion,
  displayWidth: number,
  displayHeight: number,
  viewportPixelWidth: number,
  maxPixelsPerPoint = 1,
  padding: number | PaddingSides = CAPTURE_PADDING,
): CapturePlan {
  const region = paddedRegion(visible, displayWidth, displayHeight, padding);
  const detail = wantedPixelsPerPoint(visible.width, viewportPixelWidth, maxPixelsPerPoint);
  return {
    display: { width: displayWidth, height: displayHeight },
    region,
    // Even numbers: the encoder rejects odd ones for 4:2:0 chroma, and rounding here rather than
    // three layers down keeps the size the viewer asked for the size it gets.
    pixelWidth: Math.max(16, Math.round(region.width * detail)) & ~1,
    pixelHeight: Math.max(16, Math.round(region.height * detail)) & ~1,
  };
}

/** True when a running plan still covers the view at close enough to the detail it wants. */
export function planServes(
  plan: CapturePlan | null,
  visible: CaptureRegion,
  wanted: number,
  shortfall = DETAIL_SHORTFALL,
  surplus = DETAIL_SURPLUS,
): boolean {
  if (!plan || plan.region.width <= 0) return false;
  const covers = plan.region.x <= visible.x
    && plan.region.y <= visible.y
    && plan.region.x + plan.region.width >= visible.x + visible.width
    && plan.region.y + plan.region.height >= visible.y + visible.height;
  if (!covers) return false;
  const have = plan.pixelWidth / plan.region.width;
  return have >= wanted * shortfall && have <= wanted * surplus;
}
