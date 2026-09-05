// The view of a display as a rectangle of it, ported from the DeskZoom viewer's Viewport.
//
// This is the model behind crop-based zoom, and it differs from the CSS-transform model in one
// load-bearing way: there is no transform. The state is WHICH PART of the display is on screen, in
// display points. Zoom shrinks that rectangle about an anchor; pan moves it. Everything on screen
// -- the video, the cursor -- is projected from it. The captured frame covers a different, larger
// rectangle, and is placed geometrically so that the visible part lands where it belongs; the
// viewport clips the rest. That is how a capture padded beyond the view shows exactly the view.
//
// One departure from DeskZoom, forced by the viewport. DeskZoom locks its window to the canvas's
// aspect ratio, so keeping `visible` at that aspect costs nothing: the picture always fills the
// window. This viewer's box is whatever the chrome and the keyboard leave, so a visible rect held
// at the display's aspect would sit letterboxed inside it at every zoom, leaving bars black above
// and below a picture that could have filled them. Instead `visible` takes the VIEWPORT's aspect
// while zoomed in, and is bounded by the display on each axis independently; zooming out, one axis
// reaches the display first, and when both have, it is the whole display and the bars are the
// letterbox of showing all of it. The box on screen is `visible` aspect-fitted into the viewport,
// so it is the whole viewport whenever there is more display to show and the letterbox only when
// there is not. The invariant that matters survives: visible and its box always share an aspect,
// so every projection is one uniform scale on both axes.

export interface DisplayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

/** Narrowest the visible rect's shorter axis may get, in display points: caps how far in you can zoom. */
export const MIN_VISIBLE_SIDE = 320;

export function wholeDisplay(display: DisplaySize): DisplayRect {
  return { x: 0, y: 0, width: display.width, height: display.height };
}

/** Keeps the rect inside the display without changing its size. */
export function clampVisible(rect: DisplayRect, display: DisplaySize): DisplayRect {
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, display.width - rect.width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, display.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

/** 1 when the whole display is visible, larger when zoomed in on either axis. */
export function magnification(visible: DisplayRect, display: DisplaySize): number {
  if (visible.width <= 0 || visible.height <= 0) return 1;
  return Math.max(display.width / visible.width, display.height / visible.height);
}

export function isWholeDisplay(visible: DisplayRect, display: DisplaySize): boolean {
  return visible.width >= display.width - 1e-6 && visible.height >= display.height - 1e-6;
}

/**
 * The largest rect of the viewport's aspect that fits inside the display: the most that can be
 * shown without bars. What zoom settles to just before the letterbox, and what the keyboard cover
 * wants outright.
 */
export function largestFitting(display: DisplaySize, viewportAspect: number): DisplaySize {
  if (display.width <= 0 || display.height <= 0 || !(viewportAspect > 0)) return display;
  const width = Math.min(display.width, display.height * viewportAspect);
  return { width, height: width / viewportAspect };
}

/**
 * The visible rect's size at a new area, shaped to the viewport and bounded by the display.
 *
 * Shaping by area rather than by either axis keeps a zoom factor meaning the same thing whether
 * or not the rect is currently clamped: factor 2 always shows a quarter of the area. Each axis then
 * clamps to the display on its own, which is the transition from viewport aspect to letterbox.
 */
function shaped(area: number, display: DisplaySize, viewportAspect: number): DisplaySize {
  const aspect = viewportAspect > 0 ? viewportAspect : display.width / Math.max(1, display.height);
  let height = Math.sqrt(area / aspect);
  let width = height * aspect;
  // The floor applies to the shorter axis, so a tall viewport cannot zoom into a sliver either.
  const shorter = Math.min(width, height);
  const floor = Math.min(MIN_VISIBLE_SIDE, Math.min(display.width, display.height));
  if (shorter < floor) {
    const grow = floor / shorter;
    width *= grow;
    height *= grow;
  }
  return { width: Math.min(display.width, width), height: Math.min(display.height, height) };
}

/**
 * factor > 1 zooms in. `anchor` is a display point that stays under the same screen spot. The
 * viewport's size is what the rect is shaped to; pass the same viewport the rect is shown in.
 */
export function zoomVisible(
  visible: DisplayRect,
  display: DisplaySize,
  factor: number,
  anchor: { x: number; y: number },
  viewport: DisplaySize,
): DisplayRect {
  if (display.width <= 0 || display.height <= 0 || visible.width <= 0 || visible.height <= 0 || !(factor > 0)) {
    return visible;
  }
  const size = shaped((visible.width * visible.height) / (factor * factor), display, viewport.width / viewport.height);
  const ratioX = size.width / visible.width;
  const ratioY = size.height / visible.height;
  return clampVisible({
    x: anchor.x - (anchor.x - visible.x) * ratioX,
    y: anchor.y - (anchor.y - visible.y) * ratioY,
    width: size.width,
    height: size.height,
  }, display);
}

/** Moves the visible rect by a delta in display points. */
export function panVisible(
  visible: DisplayRect,
  display: DisplaySize,
  dx: number,
  dy: number,
): DisplayRect {
  const next = clampVisible({ ...visible, x: visible.x + dx, y: visible.y + dy }, display);
  return next.x === visible.x && next.y === visible.y ? visible : next;
}

/**
 * Pans the least amount that brings `point` back inside the visible rect, keeping a margin
 * expressed as a fraction of the visible size. This is what makes the view follow the cursor
 * while zoomed in. On an axis showing the whole display the clamp makes it a no-op.
 */
export function followVisible(
  visible: DisplayRect,
  display: DisplaySize,
  point: { x: number; y: number },
  margin: number,
): DisplayRect {
  const innerX = visible.x + visible.width * margin;
  const innerY = visible.y + visible.height * margin;
  const innerRight = visible.x + visible.width * (1 - margin);
  const innerBottom = visible.y + visible.height * (1 - margin);
  let dx = 0;
  let dy = 0;
  if (point.x < innerX) dx = point.x - innerX;
  if (point.x > innerRight) dx = point.x - innerRight;
  if (point.y < innerY) dy = point.y - innerY;
  if (point.y > innerBottom) dy = point.y - innerBottom;
  if (dx === 0 && dy === 0) return visible;
  return panVisible(visible, display, dx, dy);
}

/** Pans so `point` sits at the middle of the visible rect, as far as the display allows. */
export function centreVisible(
  visible: DisplayRect,
  display: DisplaySize,
  point: { x: number; y: number },
): DisplayRect {
  return clampVisible({
    ...visible,
    x: point.x - visible.width / 2,
    y: point.y - visible.height / 2,
  }, display);
}

/**
 * A size aspect-fitted into the viewport, centred: the box the visible rect is shown in. The
 * whole viewport when the size has the viewport's aspect; letterboxed on one axis when it does
 * not, which is only ever the display's own edge showing.
 */
export function fitRect(size: DisplaySize, viewportWidth: number, viewportHeight: number): DisplayRect {
  if (size.width <= 0 || size.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const aspect = size.width / size.height;
  let width = viewportWidth;
  let height = viewportHeight;
  if (width / height > aspect) width = height * aspect;
  else height = width / aspect;
  return { x: (viewportWidth - width) / 2, y: (viewportHeight - height) / 2, width, height };
}

/**
 * Where a captured region belongs on screen, given what is visible: DeskZoom's `placeContent`.
 *
 * The frame on screen covers `region`; the view shows `visible`. This puts the frame so the two
 * agree, which is what makes a zoom or pan show immediately -- the frame already on screen is
 * simply re-placed -- and what lets a capture padded beyond the view show exactly the view once
 * the viewport clips it.
 */
export function placeRegion(region: DisplayRect, visible: DisplayRect, content: DisplayRect): DisplayRect {
  if (visible.width <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = content.width / visible.width;
  return {
    x: content.x + (region.x - visible.x) * scale,
    y: content.y + (region.y - visible.y) * scale,
    width: region.width * scale,
    height: region.height * scale,
  };
}

/** A display point to viewport pixels. */
export function projectPoint(
  point: { x: number; y: number },
  visible: DisplayRect,
  content: DisplayRect,
): { x: number; y: number } | null {
  if (visible.width <= 0 || visible.height <= 0 || content.width <= 0) return null;
  return {
    x: content.x + (point.x - visible.x) * (content.width / visible.width),
    y: content.y + (point.y - visible.y) * (content.height / visible.height),
  };
}

/**
 * Viewport pixels to a display point, clamped to the display: a pointer over the letterbox lands on
 * the nearest edge rather than off it, matching how the transform model already behaves.
 */
export function unprojectPoint(
  viewPoint: { x: number; y: number },
  visible: DisplayRect,
  content: DisplayRect,
  display: DisplaySize,
): { x: number; y: number } | null {
  if (visible.width <= 0 || visible.height <= 0 || content.width <= 0 || content.height <= 0) return null;
  const x = visible.x + (viewPoint.x - content.x) * (visible.width / content.width);
  const y = visible.y + (viewPoint.y - content.y) * (visible.height / content.height);
  return {
    x: Math.min(Math.max(0, x), Math.max(0, display.width - 1)),
    y: Math.min(Math.max(0, y), Math.max(0, display.height - 1)),
  };
}

/** True when `region` covers all of `visible`, which is the condition for showing it at all. */
export function regionCovers(region: DisplayRect, visible: DisplayRect): boolean {
  const epsilon = 1e-6;
  return region.x <= visible.x + epsilon
    && region.y <= visible.y + epsilon
    && region.x + region.width >= visible.x + visible.width - epsilon
    && region.y + region.height >= visible.y + visible.height - epsilon;
}
