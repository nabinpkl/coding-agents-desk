// Where the Mac's cursor is, as this viewer believes it: what the host reported, what this
// viewer predicted, and the moves still waiting to be sent.

import { CURSOR_MIRROR_RENDER_SCALE } from "@/features/desktop-viewer/tileViewportConstants";
import type { WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import {
  advanceRemoteCursor,
  pointerAccelerationGain,
  type ViewportPoint,
} from "@/features/desktop-viewer/tileViewportMath";
import type { ViewportRuntime } from "@/features/desktop-viewer/tileViewportRuntime";

export function createCursorMirror(ctx: ViewportRuntime) {
  return {
    applyCursorEvent: (event: WebrtcCursorEvent) => {
      if (event.type === "cursor-applied") {
        ctx.acknowledgedCursorRevision.current = Math.max(
          ctx.acknowledgedCursorRevision.current,
          event.revision,
        );
        if (event.revision !== ctx.cursorRevision.current) return;
        ctx.remoteCursor = advanceRemoteCursor(event, 0, 0, ctx.sourceWidth, ctx.sourceHeight);
        if (ctx.pointers.size < 2) {
          const { w, h } = ctx.size();
          if (ctx.view.follow(ctx.remoteCursor, w, h)) ctx.scheduleSettle();
        }
        ctx.apply();
        return;
      }
      if (event.type === "cursor-position") {
        if (ctx.acknowledgedCursorRevision.current < ctx.cursorRevision.current) return;
        ctx.remoteCursor = advanceRemoteCursor(event, 0, 0, ctx.sourceWidth, ctx.sourceHeight);
        if (ctx.pointers.size < 2) {
          const { w, h } = ctx.size();
          if (ctx.view.follow(ctx.remoteCursor, w, h)) ctx.scheduleSettle();
        }
        ctx.apply();
        return;
      }

      ctx.cursorHidden = event.hidden;
      ctx.overlay.dataset.cursorKind = event.cursorKind;
      const resolved = ctx.cursorImageCache.current.resolve(event);
      if (resolved) {
        const width = resolved.widthPoints * CURSOR_MIRROR_RENDER_SCALE;
        const height = resolved.heightPoints * CURSOR_MIRROR_RENDER_SCALE;
        ctx.image.src = resolved.source;
        ctx.image.style.width = `${width}px`;
        ctx.image.style.height = `${height}px`;
        ctx.image.style.transform = `translate(${-resolved.hotspotXFrac * width}px, ${-resolved.hotspotYFrac * height}px)`;
        ctx.image.hidden = false;
        ctx.fallback.setAttribute("hidden", "");
      }
      ctx.apply();
    },
    applyRemoteMove: (dx: number, dy: number) => {
      const revision = ctx.cursorRevision.current + 1;
      const accepted = ctx.send({ type: "pointer-move", revision, dx, dy });
      ctx.gestureInputAccepted = accepted && ctx.gestureInputAccepted;
      if (!accepted || ctx.sourceWidth <= 0 || ctx.sourceHeight <= 0) return;
      ctx.cursorRevision.current = revision;
      ctx.remoteCursor = advanceRemoteCursor(ctx.remoteCursor, dx, dy, ctx.sourceWidth, ctx.sourceHeight);
      if (ctx.pointers.size < 2) {
        const { w, h } = ctx.size();
        if (ctx.view.follow(ctx.remoteCursor, w, h)) {
          ctx.gestureEdgeFollowed = true;
          ctx.scheduleSettle();
        }
      }
      ctx.apply();
    },
    /**
     * Absolute pointing for a mouse: the pointer has a position on the picture, so the remote
     * cursor is placed at the matching source pixel rather than walked there by deltas. Runs on
     * plain hover too -- a mouse moves without a button held, and that is exactly when the cursor
     * should follow.
     */
    absoluteMouse: (event: PointerEvent) =>
      ctx.pointerMode && ctx.absolutePointerRef.current && event.pointerType === "mouse",
    warpRemoteCursor: (screen: ViewportPoint) => {
      if (ctx.sourceWidth <= 0 || ctx.sourceHeight <= 0) return;
      const { w, h } = ctx.size();
      const target = ctx.view.unproject(screen, w, h);
      if (!target) return;
      if (Math.round(target.x) === Math.round(ctx.remoteCursor.x)
          && Math.round(target.y) === Math.round(ctx.remoteCursor.y)) return;
      const revision = ctx.cursorRevision.current + 1;
      if (!ctx.send({ type: "pointer-warp", revision, x: target.x, y: target.y })) return;
      ctx.cursorRevision.current = revision;
      ctx.remoteCursor = target;
      ctx.apply();
    },
    flushPointer: (now = performance.now()) => {
      ctx.pointerFrame = 0;
      if (ctx.pendingPointerDx === 0 && ctx.pendingPointerDy === 0) return;
      const dx = ctx.pendingPointerDx;
      const dy = ctx.pendingPointerDy;
      ctx.pendingPointerDx = 0;
      ctx.pendingPointerDy = 0;
      const elapsed = Math.max((now - ctx.lastPointerFrameAt) / 1_000, 0.001);
      ctx.lastPointerFrameAt = now;
      const gain = pointerAccelerationGain(Math.hypot(dx, dy) / elapsed);
      const remoteDx = dx * gain;
      const remoteDy = dy * gain;
      ctx.applyRemoteMove(remoteDx, remoteDy);
    },
    schedulePointerFlush: () => {
      if (ctx.pointerFrame !== 0) return;
      ctx.pointerFrame = window.requestAnimationFrame(ctx.flushPointer);
    },
  };
}
