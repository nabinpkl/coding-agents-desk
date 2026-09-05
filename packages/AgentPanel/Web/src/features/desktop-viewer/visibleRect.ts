// The view of a display as a rectangle of it, ported from the DeskZoom viewer's Viewport.
//
// This is the model behind crop-based zoom, and it differs from the CSS-transform model in one
// load-bearing way: there is no transform. The state is WHICH PART of the display is on screen, in
// display points. Zoom shrinks that rectangle about an anchor; pan moves it. Everything on screen
// -- the video, the cursor -- is projected from it. The captured frame covers a different, larger
// rectangle, and is placed geometrically so that the visible part lands where it belongs; the
// viewport clips the rest. That is how a capture padded beyond the view shows exactly the view.
//
// Two invariants make the projection a single uniform scale and keep every axis honest:
// `visible` always has the display's aspect ratio, and it always lies inside the display.

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

/** Narrowest the visible rect may get, in display points: caps how far in you can zoom. */
export const MIN_VISIBLE_WIDTH = 320;

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

/** 1 when the whole display is visible, larger when zoomed in. */
export function magnification(visible: DisplayRect, display: DisplaySize): number {
  return visible.width > 0 ? display.width / visible.width : 1;
}

export function isWholeDisplay(visible: DisplayRect, display: DisplaySize): boolean {
  return visible.width >= display.width - 1e-6;
}

/**
 * factor > 1 zooms in. `anchor` is a display point that stays under the same screen spot.
 * The width is bounded on both ends; the height follows from the display's aspect.
 */
export function zoomVisible(
  visible: DisplayRect,
  display: DisplaySize,
  factor: number,
  anchor: { x: number; y: number },
): DisplayRect {
  if (display.width <= 0 || display.height <= 0 || visible.width <= 0 || factor <= 0) return visible;
  const width = Math.min(display.width, Math.max(Math.min(MIN_VISIBLE_WIDTH, display.width), visible.width / factor));
  const ratio = width / visible.width;
  return clampVisible({
    x: anchor.x - (anchor.x - visible.x) * ratio,
    y: anchor.y - (anchor.y - visible.y) * ratio,
    width,
    height: width * display.height / display.width,
  }, display);
}

/** Moves the visible rect by a delta in display points. */
export function panVisible(
  visible: DisplayRect,
  display: DisplaySize,
  dx: number,
  dy: number,
): DisplayRect {
  return clampVisible({ ...visible, x: visible.x + dx, y: visible.y + dy }, display);
}

/**
 * Pans the least amount that brings `point` back inside the visible rect, keeping a margin
 * expressed as a fraction of the visible size. This is what makes the view follow the cursor
 * while zoomed in. A no-op when the whole display is visible.
 */
export function followVisible(
  visible: DisplayRect,
  display: DisplaySize,
  point: { x: number; y: number },
  margin: number,
): DisplayRect {
  if (isWholeDisplay(visible, display)) return visible;
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

/**
 * The part of the viewport the aspect-fitted display occupies: the display's aspect, centred,
 * letterboxed on the axis with room to spare. Because `visible` shares that aspect, the map from
 * visible to this box is one uniform scale on both axes.
 */
export function contentRect(display: DisplaySize, viewportWidth: number, viewportHeight: number): DisplayRect {
  if (display.width <= 0 || display.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const aspect = display.width / display.height;
  let width = viewportWidth;
  let height = viewportHeight;
  if (width / height > aspect) width = height * aspect;
  else height = width / aspect;
  return { x: (viewportWidth - width) / 2, y: (viewportHeight - height) / 2, width, height };
}

/**
 * The display-aspect box that COVERS the viewport rather than fitting inside it: no letterbox,
 * with the overflow on one axis clipped. What the keyboard-cover view wants, where the strip left
 * above the keyboard would otherwise be mostly bars.
 */
export function coverRect(display: DisplaySize, viewportWidth: number, viewportHeight: number): DisplayRect {
  if (display.width <= 0 || display.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.max(viewportWidth / display.width, viewportHeight / display.height);
  const width = display.width * scale;
  const height = display.height * scale;
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
