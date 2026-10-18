// The scroll puck: dragging it, tapping it, and the arbitration a double tap needs.

import { SCROLL_SLOP } from "@/features/desktop-viewer/pointer-input/gestureConstants";
import type { ViewportRuntime } from "@/features/desktop-viewer/tile-viewport/tileViewportRuntime";

export function createPuckHandlers(ctx: ViewportRuntime) {
  return {
    puckDown: (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!ctx.puck || ctx.puckPointer) return;
      try {
        ctx.puck.setPointerCapture(event.pointerId);
      } catch {
        // A lost capture only ends the drag early; the control remains on screen.
      }
      ctx.puckPointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragged: false,
      };
    },
    puckMove: (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!ctx.puckPointer || ctx.puckPointer.id !== event.pointerId) return;
      const crossedSlop =
        !ctx.puckPointer.dragged &&
        Math.hypot(event.clientX - ctx.puckPointer.startX, event.clientY - ctx.puckPointer.startY) >= SCROLL_SLOP;
      if (crossedSlop) {
        ctx.puckPointer.dragged = true;
      }
      // UIPanGestureRecognizer's first changed callback carries the complete translation that
      // crossed recognition slop. Preserve that initial travel instead of swallowing it.
      const dx = event.clientX - (crossedSlop ? ctx.puckPointer.startX : ctx.puckPointer.lastX);
      const dy = event.clientY - (crossedSlop ? ctx.puckPointer.startY : ctx.puckPointer.lastY);
      ctx.puckPointer.lastX = event.clientX;
      ctx.puckPointer.lastY = event.clientY;
      if (!ctx.puckPointer.dragged || (dx === 0 && dy === 0)) return;
      ctx.puckOffset = { right: ctx.puckOffset.right - dx, bottom: ctx.puckOffset.bottom - dy };
      ctx.applyPuckOffset(true);
    },
    finishPuckPointer: (event: PointerEvent, cancelled: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      if (!ctx.puckPointer || ctx.puckPointer.id !== event.pointerId) return;
      const completed = ctx.puckPointer;
      ctx.puckPointer = null;
      if (cancelled || completed.dragged) return;
      const now = performance.now();
      const isDoubleTap =
        now - ctx.lastPuckTapAt <= 300 &&
        Math.hypot(event.clientX - ctx.lastPuckTapX, event.clientY - ctx.lastPuckTapY) <= 24;
      if (isDoubleTap) {
        if (ctx.pendingPuckTap !== 0) window.clearTimeout(ctx.pendingPuckTap);
        ctx.pendingPuckTap = 0;
        ctx.lastPuckTapAt = Number.NEGATIVE_INFINITY;
        ctx.toggleZoomAtPointer();
        return;
      }
      ctx.lastPuckTapAt = now;
      ctx.lastPuckTapX = event.clientX;
      ctx.lastPuckTapY = event.clientY;
      if (ctx.pendingPuckTap !== 0) window.clearTimeout(ctx.pendingPuckTap);
      ctx.pendingPuckTap = window.setTimeout(() => {
        ctx.pendingPuckTap = 0;
        ctx.setScrollEngaged(!ctx.scrollEngagedRef.current);
      }, 300);
    },
    puckUp: (event: PointerEvent) => ctx.finishPuckPointer(event, false),
    puckCancel: (event: PointerEvent) => ctx.finishPuckPointer(event, true),
  };
}
