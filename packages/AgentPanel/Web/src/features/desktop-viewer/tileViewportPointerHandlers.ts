// What a pointer landing on the tile turns out to be.
//
// One finger can become a cursor move, a held button, a scroll under the clutch, or half a
// pinch, and none of that is known at the press. Everything here is that decision and what
// it does once made.

import {
  POINTER_SLOP,
  SCROLL_SLOP,
  TOUCH_DRAG_HOLD_MS,
} from "@/features/desktop-viewer/tileViewportConstants";
import type { ViewportPoint } from "@/features/desktop-viewer/tileViewportMath";
import type { ViewportRuntime } from "@/features/desktop-viewer/tileViewportRuntime";

export function createPointerHandlers(ctx: ViewportRuntime) {
  return {
    down: (event: PointerEvent) => {
      // A press supersedes a wheel scroll still waiting out its idle timer; the far Mac must not
      // be left inside an open phase while a button goes down.
      ctx.endWheelScroll();
      try {
        ctx.frame.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that vanished between down and capture still pans fine;
        // losing capture only costs tracking outside the element.
      }
      const at = ctx.local(event);
      // A press can arrive without a hover first (entering the window already clicking), so put the
      // cursor under it now: the click that follows on release fires wherever the cursor is.
      if (ctx.absoluteMouse(event)) {
        // Land the cursor first, then hold the button: a drag is press, move, release, and the
        // press has to happen where the pointer actually is.
        ctx.warpRemoteCursor(at);
        ctx.send({ type: "mouse-down", button: event.button === 2 ? "right" : "left" });
        ctx.pressedMouseButton = event.button === 2 ? "right" : "left";
        // The same held marker a finger gets. A mouse drag reads as nothing at all without it:
        // the button is down on the Mac and the panel shows no sign of it.
        ctx.showDragHeld(true);
        return;
      }
      const countBefore = ctx.pointers.size;
      if (countBefore === 0) {
        ctx.pointerSequenceConsumed = ctx.pointerGestureStartRef.current?.() === true;
      }
      if (ctx.pointerSequenceConsumed) {
        ctx.pointers.set(event.pointerId, { ...at, startX: at.x, startY: at.y });
        return;
      }
      if (countBefore === 0) {
        if (ctx.pointerMode && ctx.scrollEngagedRef.current) ctx.stopMomentum(true);
        ctx.didCrossPointerSlop = false;
        ctx.hadMultiplePointers = false;
        ctx.pendingPointerDx = 0;
        ctx.pendingPointerDy = 0;
        ctx.lastPointerFrameAt = performance.now();
        ctx.pendingScrollDx = 0;
        ctx.pendingScrollDy = 0;
        ctx.scrollActive = false;
        ctx.lastScrollVelocity = { x: 0, y: 0 };
        ctx.lastScrollFrameAt = performance.now();
        ctx.lastScrollSampleAt = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
      } else {
        ctx.hadMultiplePointers = true;
        if (ctx.pointerFrame !== 0) window.cancelAnimationFrame(ctx.pointerFrame);
        ctx.pointerFrame = 0;
        ctx.pendingPointerDx = 0;
        ctx.pendingPointerDy = 0;
        if (ctx.scrollFrame !== 0 || ctx.scrollActive) ctx.endScroll(false);
      }
      ctx.pointers.set(event.pointerId, { ...at, startX: at.x, startY: at.y });
      if (countBefore === 0) {
        ctx.startGesture(ctx.pointerMode
          ? (ctx.scrollEngagedRef.current ? "scroll" : "pointer")
          : "view-pan");
        // Only a lone finger meant for the remote pointer can become a held button. A scrolling
        // finger already means something else, and view-pan never touches the far Mac.
        if (ctx.pointerMode && !ctx.scrollEngagedRef.current) ctx.armTouchHold();
      } else if (countBefore === 1) {
        ctx.cancelTouchHold();
        ctx.releaseTouchDrag();
        ctx.finishGesture("superseded");
        ctx.startGesture("pinch-pan");
      }
    },
    move: (event: PointerEvent) => {
      // Before the tracking guard on purpose: a hovering mouse has no pointerdown behind it, and
      // hover is precisely when an absolute cursor should follow.
      if (ctx.absoluteMouse(event)) {
        const samples = event.getCoalescedEvents?.() ?? [event];
        ctx.warpRemoteCursor(ctx.local(samples[samples.length - 1] ?? event));
        return;
      }
      const previous = ctx.pointers.get(event.pointerId);
      if (!previous) return;
      if (ctx.pointerSequenceConsumed) return;
      if (ctx.pointerMode && ctx.pointers.size === 1) {
        const samples = event.getCoalescedEvents?.() ?? [event];
        for (const sample of samples.length > 0 ? samples : [event]) {
          const before = ctx.pointers.get(event.pointerId);
          if (!before) break;
          const now = ctx.local(sample);
          ctx.pointers.set(event.pointerId, { ...before, ...now });
          if (ctx.hadMultiplePointers) continue;
          if (!ctx.didCrossPointerSlop) {
            const slop = ctx.scrollEngagedRef.current ? SCROLL_SLOP : POINTER_SLOP;
            if (Math.hypot(now.x - before.startX, now.y - before.startY) < slop) continue;
            ctx.cancelTouchHold();
            ctx.didCrossPointerSlop = true;
            ctx.reportGestureStart();
          }
          const dx = now.x - before.x;
          const dy = now.y - before.y;
          if (ctx.scrollEngagedRef.current) {
            const sampleAt = Number.isFinite(sample.timeStamp) ? sample.timeStamp : performance.now();
            const elapsed = Math.max((sampleAt - ctx.lastScrollSampleAt) / 1_000, 0.001);
            ctx.lastScrollSampleAt = sampleAt;
            if (dx !== 0 || dy !== 0) {
              ctx.lastScrollVelocity = { x: dx / elapsed, y: dy / elapsed };
              ctx.pendingScrollDx += dx;
              ctx.pendingScrollDy += dy;
              ctx.scheduleScrollFlush();
            }
          } else {
            ctx.pendingPointerDx += dx;
            ctx.pendingPointerDy += dy;
            ctx.schedulePointerFlush();
          }
        }
        return;
      }

      const now = ctx.local(event);
      ctx.pointers.set(event.pointerId, { ...previous, ...now });
      const { w, h } = ctx.size();

      if (ctx.pointers.size === 2) {
        const otherPrevious = [...ctx.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (!otherPrevious) return;
        // Distance change about the centroid zooms; centroid drift pans.
        const previousDistance = Math.hypot(otherPrevious.x - previous.x, otherPrevious.y - previous.y);
        const distance = Math.hypot(otherPrevious.x - now.x, otherPrevious.y - now.y);
        const cx = (otherPrevious.x + now.x) / 2;
        const cy = (otherPrevious.y + now.y) / 2;
        if (previousDistance > 0 && distance > 0) {
          ctx.gestureTransformed = ctx.view.zoomAt(distance / previousDistance, cx, cy, w, h) || ctx.gestureTransformed;
        }
        ctx.gestureTransformed = ctx.view.panBy((now.x - previous.x) / 2, (now.y - previous.y) / 2, w, h) || ctx.gestureTransformed;
        ctx.apply();
        return;
      }
      if (!ctx.pointerMode && ctx.pointers.size === 1 && ctx.view.isZoomed()) {
        ctx.reportGestureStart();
        ctx.gestureTransformed = ctx.view.panBy(now.x - previous.x, now.y - previous.y, w, h) || ctx.gestureTransformed;
        ctx.apply();
      }
    },
    up: (event: PointerEvent) => {
      const at = ctx.pointers.get(event.pointerId);
      if (ctx.pressedMouseButton !== null && event.pointerType === "mouse") {
        // The whole mouse sequence is press/release; the tap-to-click path below is for fingers.
        ctx.pointers.delete(event.pointerId);
        ctx.releaseMouseButton();
        return;
      }
      const countBefore = ctx.pointers.size;
      ctx.pointers.delete(event.pointerId);
      if (ctx.pointers.size === 0 && ctx.gestureTransformed) ctx.scheduleSettle();
      if (!at) return;
      if (ctx.pointerSequenceConsumed) {
        if (ctx.pointers.size === 0) ctx.pointerSequenceConsumed = false;
        return;
      }
      if (ctx.pointerMode) {
        if (countBefore === 1) {
          if (ctx.pointerFrame !== 0) window.cancelAnimationFrame(ctx.pointerFrame);
          ctx.pointerFrame = 0;
          if (ctx.scrollEngagedRef.current && !ctx.hadMultiplePointers) {
            ctx.endScroll(ctx.didCrossPointerSlop);
          } else {
            ctx.flushPointer();
          }
          ctx.cancelTouchHold();
          const dropped = ctx.releaseTouchDrag();
          if (!dropped && !ctx.hadMultiplePointers && !ctx.didCrossPointerSlop) {
            const focusRequestId = ctx.beforeRemoteClickRef.current?.();
            ctx.gestureInputAccepted = ctx.send({
              type: "click",
              button: "left",
              ...(focusRequestId ? { focusRequestId } : {}),
            })
              && ctx.gestureInputAccepted;
          }
          if (ctx.activeGesture?.kind === "pinch-pan") {
            ctx.finishGesture(ctx.gestureTransformed ? "transformed" : "unchanged");
          } else if (dropped) {
            ctx.finishGesture("drag");
          } else {
            ctx.finishGesture(ctx.didCrossPointerSlop
              ? (ctx.scrollEngagedRef.current ? "scroll" : "move")
              : "click");
          }
        }
        return;
      }
      // Manual double-tap: two quick releases near the same spot. dblclick is
      // unreliable for touch inside a WKWebView.
      const nowMs = performance.now();
      if (nowMs - ctx.lastTapAt < 300 && Math.hypot(at.x - ctx.lastTapX, at.y - ctx.lastTapY) < 24) {
        const { w, h } = ctx.size();
        if (ctx.view.isZoomed()) ctx.view.reset();
        else ctx.view.zoomAt(2.5, at.x, at.y, w, h);
        ctx.scheduleSettle();
        ctx.apply();
        ctx.lastTapAt = 0;
        ctx.finishGesture("transformed");
        return;
      }
      ctx.lastTapAt = nowMs;
      ctx.lastTapX = at.x;
      ctx.lastTapY = at.y;
      if (ctx.pointers.size === 0) {
        ctx.finishGesture(ctx.gestureTransformed ? "transformed" : "unchanged");
      }
    },
    cancel: (event: PointerEvent) => {
      ctx.pointers.delete(event.pointerId);
      if (ctx.pressedMouseButton !== null && event.pointerType === "mouse") {
        // A cancelled drag still has to let go, or the Mac is left with a button held down.
        ctx.releaseMouseButton();
        return;
      }
      ctx.cancelTouchHold();
      ctx.releaseTouchDrag();
      if (ctx.pointerSequenceConsumed) {
        if (ctx.pointers.size === 0) ctx.pointerSequenceConsumed = false;
        return;
      }
      if (ctx.pointers.size === 0) {
        if (ctx.pointerFrame !== 0) window.cancelAnimationFrame(ctx.pointerFrame);
        ctx.pointerFrame = 0;
        ctx.pendingPointerDx = 0;
        ctx.pendingPointerDy = 0;
        if (ctx.scrollFrame !== 0 || ctx.scrollActive) ctx.endScroll(false);
        ctx.finishGesture("cancelled");
      }
    },
    wheel: (event: WheelEvent) => {
      // The tile owns its wheel: a trackpad pinch (ctrl-wheel) zooms about the
      // cursor, a plain scroll pans when zoomed. Either way the page must not
      // scroll out from under the gesture.
      event.preventDefault();
      // The puck means "scrolling", whichever pointer is driving it, so an engaged puck sends the
      // wheel to the far Mac instead of panning the local picture. It reuses the finger's phase
      // protocol and its `endScroll`, and differs only where a wheel genuinely differs: its delta
      // needs no curve and its end has to be inferred. A pinch stays local, being a view gesture.
      if (ctx.scrollEngagedRef.current && !event.ctrlKey && !event.metaKey) {
        // A wheel delta points where the content is pushed away; the wire carries finger deltas,
        // which point where the content follows. Same negation the local pan below uses.
        const dx = -event.deltaX;
        const dy = -event.deltaY;
        if (dx === 0 && dy === 0) return;
        // Leftover momentum from a finger belongs to a gesture this wheel just replaced.
        if (ctx.wheelIdleTimer === 0) ctx.stopMomentum(true);
        ctx.sendWheelScroll(dx, dy);
        ctx.armWheelIdle();
        return;
      }
      const { w, h } = ctx.size();
      const at = ctx.local(event);
      let moved = false;
      if (event.ctrlKey || event.metaKey) {
        moved = ctx.view.zoomAt(Math.exp(-event.deltaY * 0.01), at.x, at.y, w, h);
      } else if (ctx.view.isZoomed()) {
        moved = ctx.view.panBy(-event.deltaX, -event.deltaY, w, h);
      }
      ctx.apply();
      if (moved) ctx.scheduleSettle();
    },
  };
}
