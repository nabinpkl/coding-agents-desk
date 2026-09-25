/* Drag-to-select overlay, like the macOS region screenshot: a crosshair over
 * the page, press and drag a rectangle, release to finish. Outside the
 * selection dims while dragging and a size label follows the corner. A drag
 * smaller than MIN_SIZE is treated as a stray click and ignored. The overlay
 * swallows pointer events so the page never sees the drag. */

const MIN_SIZE = 4;

export interface RegionSelector {
  /** Shows or hides the crosshair layer. Hiding also abandons a drag in progress. */
  arm(on: boolean): void;
  dragging(): boolean;
  cancelDrag(): void;
}

export function createRegionSelector(onSelect: (rect: DOMRect) => void): RegionSelector {
  const layer = document.createElement("div");
  const sel = document.createElement("div");
  const size = document.createElement("div");
  for (const el of [layer, sel, size]) el.setAttribute("data-ax-ui", "1");
  layer.style.cssText = "position:fixed;inset:0;z-index:2147483644;cursor:crosshair;display:none;touch-action:none;";
  sel.style.cssText =
    "position:fixed;z-index:2147483645;pointer-events:none;display:none;box-sizing:border-box;border:1px solid rgba(255,255,255,.95);outline:1px solid rgba(0,0,0,.45);box-shadow:0 0 0 200vmax rgba(0,0,0,.3);";
  size.style.cssText =
    "position:fixed;z-index:2147483646;pointer-events:none;display:none;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;font:11px/16px -apple-system,BlinkMacSystemFont,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;";
  document.documentElement.append(layer, sel, size);

  let start: { x: number; y: number } | null = null;
  let pointerId: number | null = null;

  function clampX(x: number): number {
    return Math.min(Math.max(x, 0), window.innerWidth);
  }
  function clampY(y: number): number {
    return Math.min(Math.max(y, 0), window.innerHeight);
  }

  function rectTo(x: number, y: number): DOMRect {
    if (!start) throw new Error("region drag has no start point");
    const cx = clampX(x);
    const cy = clampY(y);
    return new DOMRect(Math.min(start.x, cx), Math.min(start.y, cy), Math.abs(cx - start.x), Math.abs(cy - start.y));
  }

  function draw(r: DOMRect): void {
    Object.assign(sel.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    size.style.display = "block";
    // Below-right of the selection, flipped inside when it would leave the viewport.
    const w = size.offsetWidth;
    const h = size.offsetHeight;
    const left = r.right + 6 + w > window.innerWidth ? r.right - w - 4 : r.right + 6;
    const top = r.bottom + 6 + h > window.innerHeight ? r.bottom - h - 4 : r.bottom + 6;
    Object.assign(size.style, { left: `${Math.max(left, 0)}px`, top: `${Math.max(top, 0)}px` });
  }

  function reset(): void {
    if (pointerId !== null && layer.hasPointerCapture(pointerId)) layer.releasePointerCapture(pointerId);
    start = null;
    pointerId = null;
    sel.style.display = "none";
    size.style.display = "none";
  }

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    start = { x: clampX(e.clientX), y: clampY(e.clientY) };
    pointerId = e.pointerId;
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== pointerId) return;
    e.preventDefault();
    draw(rectTo(e.clientX, e.clientY));
  });
  layer.addEventListener("pointerup", (e) => {
    if (!start || e.pointerId !== pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const r = rectTo(e.clientX, e.clientY);
    reset();
    if (r.width >= MIN_SIZE && r.height >= MIN_SIZE) onSelect(r);
  });
  layer.addEventListener("pointercancel", reset);
  // The page must not see the click that ends a drag.
  layer.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  return {
    arm(on) {
      if (!on) reset();
      layer.style.display = on ? "block" : "none";
    },
    dragging() {
      return start !== null;
    },
    cancelDrag: reset,
  };
}
