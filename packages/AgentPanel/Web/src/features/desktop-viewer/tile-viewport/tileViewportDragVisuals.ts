// The marks a touch leaves while it decides what it is: the priming ring, the held halo,
// and the puck's own resting place.
//
// Written straight onto elements rather than through React, because they have to keep up
// with a finger.

import {
  DRAG_PRIMING_CIRCUMFERENCE,
  DRAG_PRIMING_DELAY_MS,
  POINTER_SCROLL_PUCK_SIDE,
  POINTER_SCROLL_PUCK_STORAGE_KEY,
  TOUCH_DRAG_HOLD_MS,
} from "./tileViewportConstants";
import type { ViewportRuntime } from "./tileViewportRuntime";

export function createDragVisuals(ctx: ViewportRuntime) {
  return {
    showDragPriming: (priming: boolean) => {
      const ring = ctx.dragPriming.current;
      if (!ring) return;
      ctx.touchPrimingArc?.cancel();
      ctx.touchPrimingArc = null;
      ring.hidden = !priming;
      if (!priming) return;
      const elapsed = DRAG_PRIMING_DELAY_MS / TOUCH_DRAG_HOLD_MS;
      ctx.touchPrimingArc = ctx.dragPrimingArc.current?.animate?.(
        [
          { strokeDashoffset: DRAG_PRIMING_CIRCUMFERENCE * (1 - elapsed) },
          { strokeDashoffset: 0 },
        ],
        { duration: TOUCH_DRAG_HOLD_MS - DRAG_PRIMING_DELAY_MS, easing: "linear", fill: "forwards" },
      ) ?? null;
    },
    cancelTouchHold: () => {
      // Ahead of the timer check: the ring outlives the timer by the moment the hold fires in, and
      // a ring left on screen is worse than one that never showed.
      ctx.showDragPriming(false);
      if (ctx.touchPrimingTimer !== 0) {
        window.clearTimeout(ctx.touchPrimingTimer);
        ctx.touchPrimingTimer = 0;
      }
      if (ctx.touchHoldTimer === 0) return;
      window.clearTimeout(ctx.touchHoldTimer);
      ctx.touchHoldTimer = 0;
    },
    showDragHeld: (held: boolean) => {
      const halo = ctx.dragHalo.current;
      if (halo) halo.hidden = !held;
    },
    /**
     * Let go of a mouse button, wherever the sequence ends.
     *
     * A mouse holds its own button rather than earning one by waiting, so it never goes through
     * the touch hold; it still has to be let go on every exit, including the teardown, for the
     * same reason a held finger does. A button left down on the far Mac outlives the page.
     */
    releaseMouseButton: () => {
      if (ctx.pressedMouseButton === null) return;
      ctx.send({ type: "mouse-up", button: ctx.pressedMouseButton });
      ctx.pressedMouseButton = null;
      ctx.showDragHeld(false);
    },
    /** True when a held button was actually let go, which is what suppresses the tap-click. */
    releaseTouchDrag: () => {
      if (!ctx.touchDragHeld) return false;
      ctx.touchDragHeld = false;
      ctx.showDragHeld(false);
      ctx.gestureInputAccepted = ctx.send({ type: "mouse-up", button: "left" }) && ctx.gestureInputAccepted;
      return true;
    },
    armTouchHold: () => {
      ctx.cancelTouchHold();
      ctx.touchPrimingTimer = window.setTimeout(() => {
        ctx.touchPrimingTimer = 0;
        if (ctx.didCrossPointerSlop || ctx.hadMultiplePointers || ctx.pointers.size !== 1) return;
        ctx.showDragPriming(true);
      }, DRAG_PRIMING_DELAY_MS);
      ctx.touchHoldTimer = window.setTimeout(() => {
        ctx.touchHoldTimer = 0;
        // The ring has done its job either way: what follows is the held state or nothing.
        ctx.showDragPriming(false);
        // The finger has to still be down, alone, and to have stayed inside the slop. Any of those
        // failing means this was a move, a pinch, or a tap that already ended.
        if (ctx.didCrossPointerSlop || ctx.hadMultiplePointers || ctx.pointers.size !== 1) return;
        if (!ctx.send({ type: "mouse-down", button: "left" })) {
          ctx.gestureInputAccepted = false;
          return;
        }
        ctx.touchDragHeld = true;
        ctx.showDragHeld(true);
      }, TOUCH_DRAG_HOLD_MS);
    },
    applyPuckOffset: (persist: boolean) => {
      if (!ctx.puck) return;
      const { w, h } = ctx.size();
      if (w > 0 && h > 0) {
        ctx.puckOffset = {
          right: Math.min(Math.max(0, ctx.puckOffset.right), Math.max(0, w - POINTER_SCROLL_PUCK_SIDE)),
          bottom: Math.min(Math.max(0, ctx.puckOffset.bottom), Math.max(0, h - POINTER_SCROLL_PUCK_SIDE)),
        };
      }
      ctx.puck.style.right = `${ctx.puckOffset.right}px`;
      ctx.puck.style.bottom = `max(${ctx.puckOffset.bottom}px, var(--desktop-chrome-clearance, 0px))`;
      if (!persist) return;
      try {
        window.localStorage.setItem(POINTER_SCROLL_PUCK_STORAGE_KEY, JSON.stringify(ctx.puckOffset));
      } catch {
        // The position is a convenience. A storage-denied webview keeps the current placement.
      }
    },
    toggleZoomAtPointer: () => {
      const { w, h } = ctx.size();
      const projected = ctx.view.project(ctx.remoteCursor, w, h) ?? { x: w / 2, y: h / 2 };
      if (ctx.view.isZoomed()) ctx.view.reset();
      else ctx.view.zoomAt(2.5, projected.x, projected.y, w, h);
      ctx.scheduleSettle();
      ctx.apply();
    },
  };
}
