// The cursor as this viewport draws it: the Mac's cursor image, where the shared cursor model
// says the pointer is, and the view following it to the edge.
//
// The position itself is not kept here. It belongs to the viewer's `RemoteCursor`, which the
// trackpad moves too; this redraws when it changes.

import { CURSOR_MIRROR_RENDER_SCALE } from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import type { WebrtcCursorEvent } from "@agentdesk/agent-feed-wire";
import type { ViewportPoint } from "@/features/desktop-viewer/tile-viewport/tileViewportMath";
import type { RemoteCursorChange } from "@/features/desktop-viewer/pointer-input/remoteCursor";
import type { ViewportRuntime } from "@/features/desktop-viewer/tile-viewport/tileViewportRuntime";

export function createCursorMirror(ctx: ViewportRuntime) {
  return {
    applyCursorEvent: (event: WebrtcCursorEvent) => {
      if (event.type === "cursor-applied" || event.type === "cursor-position") {
        ctx.input.cursor.applyEvent(event);
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
    /**
     * The cursor moved, by this viewer's hand or by the Mac's word: follow it to the edge of a
     * zoomed view and redraw. Not while two fingers are on the picture, which is the reader
     * moving the view themselves.
     */
    cursorChanged: (change: RemoteCursorChange) => {
      if ((change === "local" || change === "host") && ctx.pointers.size < 2) {
        const { w, h } = ctx.size();
        if (ctx.view.follow(ctx.input.cursor.position, w, h)) {
          if (change === "local") ctx.gestureEdgeFollowed = true;
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
      const { w, h } = ctx.size();
      const target = ctx.view.unproject(screen, w, h);
      if (!target) return;
      ctx.input.cursor.warp(target);
    },
  };
}
