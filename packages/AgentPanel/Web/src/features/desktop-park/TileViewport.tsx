"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  IDENTITY,
  panBy,
  zoomAt,
  type ViewportTransform,
} from "./tileViewportMath";

/**
 * A map-style viewport around a live tile: pinch or ctrl-wheel zooms about the
 * gesture point, a drag pans when zoomed, a double tap toggles in and out.
 *
 * The video underneath stays a dumb GPU rectangle. This overlay owns EVERY
 * pointer (`touch-action: none`), which is also what stops a drag on the tile
 * from scrolling the page and shoving the video around: gestures on the tile
 * belong to the tile. The pan and zoom are one CSS transform on the content
 * wrapper, compositor-composited with the video, so no frame is ever redrawn
 * by the page. The same transform's inverse is the future remote-control
 * mapping from a finger to a desktop coordinate.
 *
 * Transform state lives in refs and is applied by direct style writes: a
 * pointermove per frame through React state would re-render the tile sixty
 * times a second for no layout change.
 */
export function TileViewport({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = viewport.current;
    const inner = content.current;
    if (!frame || !inner) return undefined;

    let transform: ViewportTransform = IDENTITY;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const apply = () => {
      inner.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
    };
    const size = () => ({ w: frame.clientWidth, h: frame.clientHeight });
    const local = (event: PointerEvent | WheelEvent) => {
      const box = frame.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    const down = (event: PointerEvent) => {
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that vanished between down and capture still pans fine;
        // losing capture only costs tracking outside the element.
      }
      pointers.set(event.pointerId, local(event));
    };

    const move = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const now = local(event);
      pointers.set(event.pointerId, now);
      const { w, h } = size();

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const otherPrevious = a === now ? b : a;
        // Distance change about the centroid zooms; centroid drift pans.
        const previousDistance = Math.hypot(otherPrevious.x - previous.x, otherPrevious.y - previous.y);
        const distance = Math.hypot(otherPrevious.x - now.x, otherPrevious.y - now.y);
        const cx = (otherPrevious.x + now.x) / 2;
        const cy = (otherPrevious.y + now.y) / 2;
        if (previousDistance > 0 && distance > 0) {
          transform = zoomAt(transform, distance / previousDistance, cx, cy, w, h);
        }
        transform = panBy(transform, (now.x - previous.x) / 2, (now.y - previous.y) / 2, w, h);
        apply();
        return;
      }
      if (pointers.size === 1 && transform.scale > 1) {
        transform = panBy(transform, now.x - previous.x, now.y - previous.y, w, h);
        apply();
      }
    };

    const up = (event: PointerEvent) => {
      const at = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      if (!at) return;
      // Manual double-tap: two quick releases near the same spot. dblclick is
      // unreliable for touch inside a WKWebView.
      const nowMs = performance.now();
      if (nowMs - lastTapAt < 300 && Math.hypot(at.x - lastTapX, at.y - lastTapY) < 24) {
        const { w, h } = size();
        transform = transform.scale > 1 ? IDENTITY : zoomAt(transform, 2.5, at.x, at.y, w, h);
        apply();
        lastTapAt = 0;
        return;
      }
      lastTapAt = nowMs;
      lastTapX = at.x;
      lastTapY = at.y;
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
    };

    const wheel = (event: WheelEvent) => {
      // The tile owns its wheel: a trackpad pinch (ctrl-wheel) zooms about the
      // cursor, a plain scroll pans when zoomed. Either way the page must not
      // scroll out from under the gesture.
      event.preventDefault();
      const { w, h } = size();
      const at = local(event);
      if (event.ctrlKey || event.metaKey) {
        transform = zoomAt(transform, Math.exp(-event.deltaY * 0.01), at.x, at.y, w, h);
      } else if (transform.scale > 1) {
        transform = panBy(transform, -event.deltaX, -event.deltaY, w, h);
      }
      apply();
    };

    frame.addEventListener("pointerdown", down);
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", cancel);
    // Non-passive on purpose: preventDefault on a wheel only works that way.
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => {
      frame.removeEventListener("pointerdown", down);
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", cancel);
      frame.removeEventListener("wheel", wheel);
    };
  }, []);

  return (
    <div
      ref={viewport}
      className="relative overflow-hidden select-none"
      style={{ touchAction: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
    >
      <div ref={content} className="origin-top-left will-change-transform">
        {children}
      </div>
    </div>
  );
}
