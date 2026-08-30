"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { WebrtcPointerInput } from "@agentdesk/agent-feed-wire";
import {
  IDENTITY,
  panBy,
  pointerAccelerationGain,
  scrollAccelerationGain,
  zoomAt,
  type ViewportTransform,
} from "./tileViewportMath";

/**
 * A map-style viewport around a live tile, or a relative Mac pointer surface.
 *
 * The video underneath stays a dumb GPU rectangle. This overlay owns EVERY
 * pointer (`touch-action: none`), which is also what stops a drag on the tile
 * from scrolling the page and shoving the video around: gestures on the tile
 * belong to the tile. The pan and zoom are one CSS transform on the content
 * wrapper, compositor-composited with the video, so no frame is ever redrawn
 * by the page. Pointer mode deliberately does not use that mapping: like the
 * native client's Pointer mode and TeamViewer's mouse surface, one finger
 * moves the existing Mac pointer relatively and a tap clicks where it is.
 *
 * Transform state lives in refs and is applied by direct style writes: a
 * pointermove per frame through React state would re-render the tile sixty
 * times a second for no layout change.
 */
export function TileViewport({
  children,
  className = "",
  pointerMode = false,
  sendPointerInput,
}: {
  children: ReactNode;
  className?: string;
  pointerMode?: boolean;
  sendPointerInput?: (input: WebrtcPointerInput) => boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sendPointerInputRef = useRef(sendPointerInput);

  useEffect(() => {
    sendPointerInputRef.current = sendPointerInput;
  }, [sendPointerInput]);

  useEffect(() => {
    const frame = viewport.current;
    const inner = content.current;
    if (!frame || !inner) return undefined;

    let transform: ViewportTransform = IDENTITY;
    const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let didCrossPointerSlop = false;
    let hadMultiplePointers = false;
    let pendingPointerDx = 0;
    let pendingPointerDy = 0;
    let pointerFrame = 0;
    let lastPointerFrameAt = performance.now();
    let pendingScrollDx = 0;
    let pendingScrollDy = 0;
    let scrollFrame = 0;
    let scrollActive = false;
    let lastScrollFrameAt = performance.now();

    const apply = () => {
      inner.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
    };
    const size = () => ({ w: frame.clientWidth, h: frame.clientHeight });
    const local = (event: PointerEvent | WheelEvent) => {
      const box = frame.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const send = (input: WebrtcPointerInput) => sendPointerInputRef.current?.(input) ?? false;
    const flushPointer = (now = performance.now()) => {
      pointerFrame = 0;
      if (pendingPointerDx === 0 && pendingPointerDy === 0) return;
      const dx = pendingPointerDx;
      const dy = pendingPointerDy;
      pendingPointerDx = 0;
      pendingPointerDy = 0;
      const elapsed = Math.max((now - lastPointerFrameAt) / 1_000, 0.001);
      lastPointerFrameAt = now;
      const gain = pointerAccelerationGain(Math.hypot(dx, dy) / elapsed);
      send({ t: "move", dx: dx * gain, dy: dy * gain });
    };
    const schedulePointerFlush = () => {
      if (pointerFrame !== 0) return;
      pointerFrame = window.requestAnimationFrame(flushPointer);
    };
    const flushScroll = (now = performance.now()) => {
      scrollFrame = 0;
      if (pendingScrollDx === 0 && pendingScrollDy === 0) return;
      const dx = pendingScrollDx;
      const dy = pendingScrollDy;
      pendingScrollDx = 0;
      pendingScrollDy = 0;
      const elapsed = Math.max((now - lastScrollFrameAt) / 1_000, 0.001);
      lastScrollFrameAt = now;
      const gain = scrollAccelerationGain(Math.hypot(dx, dy) / elapsed);
      send({
        t: "scroll",
        dx: dx * gain,
        dy: dy * gain,
        phase: scrollActive ? "changed" : "began",
      });
      scrollActive = true;
    };
    const scheduleScrollFlush = () => {
      if (scrollFrame !== 0) return;
      scrollFrame = window.requestAnimationFrame(flushScroll);
    };
    const endScroll = () => {
      if (scrollFrame !== 0) window.cancelAnimationFrame(scrollFrame);
      flushScroll();
      if (scrollActive) send({ t: "scroll", dx: 0, dy: 0, phase: "ended" });
      scrollActive = false;
      pendingScrollDx = 0;
      pendingScrollDy = 0;
    };

    const down = (event: PointerEvent) => {
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that vanished between down and capture still pans fine;
        // losing capture only costs tracking outside the element.
      }
      const at = local(event);
      if (pointers.size === 0) {
        didCrossPointerSlop = false;
        hadMultiplePointers = false;
        pendingPointerDx = 0;
        pendingPointerDy = 0;
        lastPointerFrameAt = performance.now();
      } else {
        hadMultiplePointers = true;
        if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
        pendingPointerDx = 0;
        pendingPointerDy = 0;
        lastScrollFrameAt = performance.now();
      }
      pointers.set(event.pointerId, { ...at, startX: at.x, startY: at.y });
    };

    const move = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      if (pointerMode) {
        const samples = event.getCoalescedEvents?.() ?? [event];
        for (const sample of samples.length > 0 ? samples : [event]) {
          const before = pointers.get(event.pointerId);
          if (!before) break;
          const now = local(sample);
          if (pointers.size === 2) {
            const beforeCentroid = [...pointers.values()].reduce(
              (sum, point) => ({ x: sum.x + point.x / 2, y: sum.y + point.y / 2 }),
              { x: 0, y: 0 },
            );
            pointers.set(event.pointerId, { ...before, ...now });
            const afterCentroid = [...pointers.values()].reduce(
              (sum, point) => ({ x: sum.x + point.x / 2, y: sum.y + point.y / 2 }),
              { x: 0, y: 0 },
            );
            pendingScrollDx += afterCentroid.x - beforeCentroid.x;
            pendingScrollDy += afterCentroid.y - beforeCentroid.y;
            scheduleScrollFlush();
            continue;
          }
          pointers.set(event.pointerId, { ...before, ...now });
          if (hadMultiplePointers) continue;
          if (!didCrossPointerSlop) {
            if (Math.hypot(now.x - before.startX, now.y - before.startY) < 3) continue;
            didCrossPointerSlop = true;
          }
          pendingPointerDx += now.x - before.x;
          pendingPointerDy += now.y - before.y;
          schedulePointerFlush();
        }
        return;
      }

      const now = local(event);
      pointers.set(event.pointerId, { ...previous, ...now });
      const { w, h } = size();

      if (pointers.size === 2) {
        const otherPrevious = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (!otherPrevious) return;
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
      const countBefore = pointers.size;
      pointers.delete(event.pointerId);
      if (!at) return;
      if (pointerMode) {
        if (countBefore === 2) endScroll();
        if (countBefore === 1) {
          if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
          pointerFrame = 0;
          flushPointer();
          if (!hadMultiplePointers && !didCrossPointerSlop) {
            send({ t: "click", button: "left" });
          }
        }
        return;
      }
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
      const countBefore = pointers.size;
      pointers.delete(event.pointerId);
      if (pointerMode && countBefore === 2) endScroll();
    };

    const wheel = (event: WheelEvent) => {
      // The tile owns its wheel: a trackpad pinch (ctrl-wheel) zooms about the
      // cursor, a plain scroll pans when zoomed. Either way the page must not
      // scroll out from under the gesture.
      event.preventDefault();
      if (pointerMode) return;
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
    apply();
    return () => {
      frame.removeEventListener("pointerdown", down);
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", cancel);
      frame.removeEventListener("wheel", wheel);
      if (pointerFrame !== 0) window.cancelAnimationFrame(pointerFrame);
      if (scrollFrame !== 0) window.cancelAnimationFrame(scrollFrame);
      if (pointerMode && scrollActive) send({ t: "scroll", dx: 0, dy: 0, phase: "ended" });
    };
  }, [pointerMode]);

  return (
    <div
      ref={viewport}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ touchAction: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
    >
      <div ref={content} className="h-full origin-top-left will-change-transform">
        {children}
      </div>
    </div>
  );
}
