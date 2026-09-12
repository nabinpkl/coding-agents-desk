// The box the picture is shown in: its size, the transform written onto it, and the one
// capture request a settled gesture is allowed to make.
//
// `scheduleSettle` is where the re-aim budget lives: a pinch that ends in a dozen frames
// must ask the sidecar for a sharper capture once, not a dozen times.

import {
  VIEW_REAIM_INTERVAL_MS,
  VIEW_SETTLE_MS,
} from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import { setCaptureCrop } from "@/features/desktop-viewer/zoom/captureCrop";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import type { ViewportRuntime } from "@/features/desktop-viewer/tile-viewport/tileViewportRuntime";

export function createFrameGeometry(ctx: ViewportRuntime) {
  return {
    size: () => ({ w: ctx.frame.clientWidth, h: ctx.frame.clientHeight }),
    /**
     * One capture request per settled gesture, and never two within the re-aim interval. A pinch
     * rewrites the view every animation frame and each re-aim costs a renegotiation, so the
     * request waits for the hand to stop and then for the last re-aim to be old enough.
     */
    scheduleSettle: () => {
      if (ctx.settleTimer !== 0) window.clearTimeout(ctx.settleTimer);
      const wait = Math.max(VIEW_SETTLE_MS, VIEW_REAIM_INTERVAL_MS - (performance.now() - ctx.lastReaimAt));
      ctx.settleTimer = window.setTimeout(() => {
        ctx.settleTimer = 0;
        ctx.lastReaimAt = performance.now();
        const { w, h } = ctx.size();
        const decided = ctx.view.settle(w, h);
        // The one trace of what a phone's view decided; the sidecar log is where it can be read.
        if (decided.outcome !== "css") {
          ctx.gestureTelemetryRef.current?.({
            gestureId: ctx.activeGesture?.id ?? "settle",
            phase: "viewport-settle",
            elapsedMs: 0,
            detail: decided,
          });
        }
      }, wait);
    },
    apply: () => {
      const { w, h } = ctx.size();
      ctx.view.paint(ctx.layers, w, h);
      const projected = ctx.view.project(ctx.remoteCursor, w, h);
      ctx.overlay.hidden = !ctx.pointerMode || ctx.cursorHidden || projected === null;
      if (projected) {
        // The overlay origin is the hotspot. The glyph supplies its own offset and stays
        // phone-sized outside the transformed content while that origin follows the video.
        ctx.overlay.style.transform = `translate3d(${projected.x}px, ${projected.y}px, 0)`;
      }
    },
    local: (event: PointerEvent | WheelEvent) => {
      const box = ctx.frame.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    },
    send: (input: DesktopPointerInput) => ctx.sendPointerInputRef.current?.(input) ?? false,
    handleResize: () => {
      const { w, h } = ctx.size();
      if (ctx.keyboardPresentedRef.current) {
        // The keyboard leaves a strip, and `object-contain` would spend most of it on black bars
        // around a shrunken desktop. Fill the strip instead and aim it at the cursor, which is
        // where the typing is going. Recomputed on every resize while typing so an accessory that
        // changes height re-aims rather than drifting.
        //
        // Unless the viewer had already zoomed. The cover answers a view nobody chose; a zoom is a
        // view somebody chose, and opening the keyboard is not a reason to throw it away. The
        // snapshot doubles as the record of whose view this is: null here means the zoom was
        // theirs, so it stands and only gets clamped to the shorter box.
        if (ctx.viewBeforeKeyboard === null && ctx.view.isZoomed()) {
          ctx.view.reclamp(w, h);
        } else {
          if (ctx.viewBeforeKeyboard === null) ctx.viewBeforeKeyboard = ctx.view.snapshot();
          ctx.view.cover(ctx.remoteCursor, w, h);
        }
      } else if (ctx.viewBeforeKeyboard !== null) {
        // The cover was this viewer's doing, not the user's, so leaving the keyboard leaves it.
        ctx.view.restore(ctx.viewBeforeKeyboard, w, h);
        ctx.viewBeforeKeyboard = null;
      } else {
        // Clamping, not just re-applying: a shorter box narrows the legal range, so a pan that
        // was legal at the old height can now pull the content's bottom edge inside the viewport
        // and show black.
        ctx.view.reclamp(w, h);
      }
      ctx.scheduleSettle();
      ctx.applyPuckOffset(false);
      ctx.apply();
    },
  };
}
