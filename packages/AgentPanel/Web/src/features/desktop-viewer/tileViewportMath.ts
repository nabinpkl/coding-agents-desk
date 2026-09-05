// Pan/zoom arithmetic for a tile viewport, kept pure because gesture code is
// miserable to test and arithmetic is not.
//
// Model: the content fills the viewport exactly at scale 1. The transform is
// `translate(tx, ty) scale(scale)` with origin 0 0, both in viewport pixels.
// Zoom always happens ABOUT a point (the pinch centroid, the wheel cursor, the
// double-tap), meaning that point shows the same content before and after.

export interface ViewportTransform {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
const SCALE_EPSILON = 1e-9;

export const IDENTITY: ViewportTransform = { scale: 1, tx: 0, ty: 0 };

function aspectFitPicture(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (
    sourceWidth <= 0
    || sourceHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) return null;
  const fit = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const width = sourceWidth * fit;
  const height = sourceHeight * fit;
  return {
    x: (viewportWidth - width) / 2,
    y: (viewportHeight - height) / 2,
    width,
    height,
  };
}

/** Matches GestureTranslator's default relative pointer acceleration. */
export function pointerAccelerationGain(speed: number): number {
  return 1.5 + Math.min(Math.max(0, speed) * 0.005, 8.5);
}

/** Matches GestureTranslator's free-axis scroll acceleration curve. */
export function scrollAccelerationGain(speed: number): number {
  return 1 + Math.min(Math.max(0, speed) * 0.0045, 11);
}

/** Mirrors the native current + delta + display-bounds clamp. */
export function advanceRemoteCursor(
  current: ViewportPoint,
  dx: number,
  dy: number,
  sourceWidth: number,
  sourceHeight: number,
): ViewportPoint {
  return {
    x: Math.min(Math.max(0, current.x + dx), Math.max(0, sourceWidth - 1)),
    y: Math.min(Math.max(0, current.y + dy), Math.max(0, sourceHeight - 1)),
  };
}

/** Projects a source-display cursor into the transformed viewport. */
export function projectRemoteCursor(
  transform: ViewportTransform,
  cursor: ViewportPoint,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportPoint | null {
  const picture = aspectFitPicture(
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
  );
  if (!picture) return null;
  return {
    x: (picture.x + cursor.x * (picture.width / sourceWidth)) * transform.scale + transform.tx,
    y: (picture.y + cursor.y * (picture.height / sourceHeight)) * transform.scale + transform.ty,
  };
}

/**
 * Native-style cursor edge-follow for an aspect-fit desktop picture.
 *
 * The cursor lives in source-display points and the CSS transform lives in
 * viewport pixels. Project through the aspect-fit picture, keep the cursor in
 * the inner safe band, and clamp only axes where zoom leaves more video to
 * reveal. Scale is copied through unchanged.
 */
/**
 * The exact inverse of `projectRemoteCursor`: a point in the transformed viewport back to the
 * source display's coordinates.
 *
 * This is what absolute pointing needs -- "the mouse is here on screen, so put the remote cursor
 * at the matching pixel of the desktop" -- and it has to undo the same two steps the projection
 * applies, in reverse: the pan/zoom transform first, then the aspect-fit letterbox. Clamped to the
 * source, so a pointer over the letterbox bars lands on the nearest edge rather than off-display.
 */
export function unprojectRemoteCursor(
  transform: ViewportTransform,
  point: ViewportPoint,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportPoint | null {
  const picture = aspectFitPicture(sourceWidth, sourceHeight, viewportWidth, viewportHeight);
  if (!picture || transform.scale === 0 || picture.width === 0 || picture.height === 0) return null;
  const contentX = (point.x - transform.tx) / transform.scale - picture.x;
  const contentY = (point.y - transform.ty) / transform.scale - picture.y;
  return {
    x: Math.min(Math.max(0, contentX * (sourceWidth / picture.width)), Math.max(0, sourceWidth - 1)),
    y: Math.min(Math.max(0, contentY * (sourceHeight / picture.height)), Math.max(0, sourceHeight - 1)),
  };
}

export function followRemoteCursor(
  transform: ViewportTransform,
  cursor: ViewportPoint,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  edgeMargin = 0.12,
): ViewportTransform {
  if (transform.scale <= 1) return transform;
  const picture = aspectFitPicture(
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
  );
  if (!picture) return transform;

  const followAxis = (
    sourcePosition: number,
    sourceExtent: number,
    pictureNear: number,
    pictureExtent: number,
    viewportExtent: number,
    translation: number,
  ) => {
    const scaledExtent = pictureExtent * transform.scale;
    if (scaledExtent <= viewportExtent) return translation;

    const cursorContent = pictureNear + sourcePosition * (pictureExtent / sourceExtent);
    const cursorViewport = cursorContent * transform.scale + translation;
    const margin = viewportExtent * edgeMargin;
    let next = translation;
    if (cursorViewport < margin) {
      next += margin - cursorViewport;
    } else if (cursorViewport > viewportExtent - margin) {
      next -= cursorViewport - (viewportExtent - margin);
    }

    const maximum = -pictureNear * transform.scale;
    const minimum = viewportExtent - scaledExtent - pictureNear * transform.scale;
    return Math.min(maximum, Math.max(minimum, next));
  };

  return {
    scale: transform.scale,
    tx: followAxis(
      cursor.x,
      sourceWidth,
      picture.x,
      picture.width,
      viewportWidth,
      transform.tx,
    ),
    ty: followAxis(
      cursor.y,
      sourceHeight,
      picture.y,
      picture.height,
      viewportHeight,
      transform.ty,
    ),
  };
}

/** Pan so no edge of the content pulls inside the viewport. */
export function clampPan(
  transform: ViewportTransform,
  viewportWidth: number,
  viewportHeight: number,
): ViewportTransform {
  const minX = viewportWidth * (1 - transform.scale);
  const minY = viewportHeight * (1 - transform.scale);
  return {
    scale: transform.scale,
    tx: Math.min(0, Math.max(minX, transform.tx)),
    ty: Math.min(0, Math.max(minY, transform.ty)),
  };
}

/** Scale by `factor` about the viewport point (cx, cy), clamped and re-panned. */
export function zoomAt(
  transform: ViewportTransform,
  factor: number,
  cx: number,
  cy: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
  if (scale <= MIN_SCALE + SCALE_EPSILON) return IDENTITY;
  // The content point under (cx, cy) stays under (cx, cy).
  const contentX = (cx - transform.tx) / transform.scale;
  const contentY = (cy - transform.ty) / transform.scale;
  return clampPan(
    { scale, tx: cx - contentX * scale, ty: cy - contentY * scale },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * Fill the viewport with the picture and put the remote cursor at its centre.
 *
 * `object-contain` leaves the unconstrained axis letterboxed, which is harmless on a full-height
 * viewer and is the whole picture when the keyboard has taken half the box: what is left is a thin
 * strip of desktop floating in black. Covering removes the bars by scaling until both axes are
 * filled, and centring on the cursor decides which part of the now-larger picture the strip shows,
 * which is the part being typed into.
 *
 * `followRemoteCursor` cannot express this. It keeps an existing pan inside an edge band and bails
 * out on any axis the scale has not already overflowed, which is exactly the axis a cover fit
 * lands flush against.
 */
export function coverOnRemoteCursor(
  cursor: ViewportPoint,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportTransform {
  const picture = aspectFitPicture(
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
  );
  if (!picture) return IDENTITY;
  const scale = Math.min(MAX_SCALE, Math.max(
    MIN_SCALE,
    Math.max(viewportWidth / picture.width, viewportHeight / picture.height),
  ));

  const centreAxis = (
    sourcePosition: number,
    sourceExtent: number,
    pictureNear: number,
    pictureExtent: number,
    viewportExtent: number,
  ) => {
    // Where the cursor sits in untransformed content pixels, then the translation that puts it at
    // the middle of the viewport, then the range that keeps both content edges outside it.
    const cursorContent = pictureNear + sourcePosition * (pictureExtent / sourceExtent);
    const centred = viewportExtent / 2 - cursorContent * scale;
    const maximum = -pictureNear * scale;
    const minimum = viewportExtent - (pictureExtent + pictureNear) * scale;
    const clamped = Math.min(maximum, Math.max(minimum, centred));
    // A picture already flush against the near edge clamps to negative zero, which would reach the
    // transform string as "-0px" and read as a different translation to anything comparing values.
    return clamped === 0 ? 0 : clamped;
  };

  return {
    scale,
    tx: centreAxis(cursor.x, sourceWidth, picture.x, picture.width, viewportWidth),
    ty: centreAxis(cursor.y, sourceHeight, picture.y, picture.height, viewportHeight),
  };
}

/** Translate by a gesture delta, clamped. A no-op at scale 1 by construction. */
export function panBy(
  transform: ViewportTransform,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportTransform {
  return clampPan(
    { scale: transform.scale, tx: transform.tx + dx, ty: transform.ty + dy },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * A viewport point mapped to normalized content coordinates (0..1 each axis):
 * the future remote-control hook, because "where did the finger land on the
 * desktop" is this exact inverse.
 */
export function toContentPoint(
  transform: ViewportTransform,
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    x: (x - transform.tx) / transform.scale / viewportWidth,
    y: (y - transform.ty) / transform.scale / viewportHeight,
  };
}

/**
 * The part of the source display the viewport is currently showing, in source coordinates.
 *
 * The inverse of `projectRemoteCursor` applied to the viewport's own corners rather than to the
 * cursor, so it undoes the same two steps: the pan/zoom transform, then the aspect-fit letterbox.
 * Clamped to the source, which is what makes the letterbox disappear from the answer -- the bars
 * are viewport, not display, and a capture must not be asked for pixels that do not exist.
 *
 * This is what a cropped capture needs. Zooming in currently magnifies a picture that was already
 * scaled down to fit, so detail that was thrown away at capture time cannot come back; asking the
 * encoder for exactly this rectangle at its own pixels is how the detail survives instead. Returns
 * null when the geometry is degenerate or the visible region has collapsed below a pixel.
 */
export function visibleSourceRect(
  transform: ViewportTransform,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const picture = aspectFitPicture(sourceWidth, sourceHeight, viewportWidth, viewportHeight);
  if (!picture || transform.scale === 0 || picture.width === 0 || picture.height === 0) return null;
  const toSource = (viewportX: number, viewportY: number) => ({
    x: ((viewportX - transform.tx) / transform.scale - picture.x) * (sourceWidth / picture.width),
    y: ((viewportY - transform.ty) / transform.scale - picture.y) * (sourceHeight / picture.height),
  });
  const near = toSource(0, 0);
  const far = toSource(viewportWidth, viewportHeight);
  const left = Math.max(0, Math.min(near.x, far.x));
  const top = Math.max(0, Math.min(near.y, far.y));
  const right = Math.min(sourceWidth, Math.max(near.x, far.x));
  const bottom = Math.min(sourceHeight, Math.max(near.y, far.y));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
