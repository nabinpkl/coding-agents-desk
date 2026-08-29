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

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export const IDENTITY: ViewportTransform = { scale: 1, tx: 0, ty: 0 };

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
  if (scale === 1) return IDENTITY;
  // The content point under (cx, cy) stays under (cx, cy).
  const contentX = (cx - transform.tx) / transform.scale;
  const contentY = (cy - transform.ty) / transform.scale;
  return clampPan(
    { scale, tx: cx - contentX * scale, ty: cy - contentY * scale },
    viewportWidth,
    viewportHeight,
  );
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
