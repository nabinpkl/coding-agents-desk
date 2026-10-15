// Apart from `DesktopViewer.tsx` so that file exports only its component. `main.tsx` imports the
// viewer directly, and a component file that also exports a plain function is one Fast Refresh
// cannot update in place: every save to it reloaded every open panel.

/**
 * The document height to use when WebKit reports a zero-height viewport, which it can while a page
 * is first laid out: the physical CSS screen height, or null when the viewport is real or the
 * screen gives nothing to fall back on.
 */
export function desktopDocumentFallbackHeight(viewportHeight: number, screenHeight: number): number | null {
  if (viewportHeight > 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) return null;
  return Math.round(screenHeight);
}
