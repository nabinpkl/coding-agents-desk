// Scrolling the Mac from the picture: a finger under the puck, and the wheel.
//
// The scroll itself -- its phases, its curve, its coast -- is the shared translator's
// (`pointer-input/scrollTranslator.ts`), so a finger on the picture and a finger on the
// trackpad's scroll strip scroll the same way and share one coast. What is left here is
// what only the picture has: the slop a finger crosses before a touch is a scroll rather than a
// tap, and a wheel's end, which has to be inferred.

import { SCROLL_SLOP } from "@/features/desktop-viewer/pointer-input/gestureConstants";
import { WHEEL_SCROLL_IDLE_MS } from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import type { ViewportPoint } from "@/features/desktop-viewer/tile-viewport/tileViewportMath";
import type { ViewportRuntime } from "@/features/desktop-viewer/tile-viewport/tileViewportRuntime";

export function createScrolling(ctx: ViewportRuntime) {
  let start: ViewportPoint = { x: 0, y: 0 };
  let last: ViewportPoint = { x: 0, y: 0 };
  return {
    beginFingerScroll: (at: ViewportPoint, sampledAt: number) => {
      start = at;
      last = at;
      ctx.scrollBegun = false;
      ctx.scrollVelocity.reset();
      ctx.scrollVelocity.add(at.x, at.y, sampledAt);
    },
    /**
     * Free-axis, like the Swift client's puck: the finger is on the content, and a real trackpad
     * scrolls both axes at once. The slop travel is not sent, as UIKit's pan does not send it; the
     * scroll starts from where the finger was when it became one.
     */
    fingerScrollSamples: (samples: readonly { at: ViewportPoint; sampledAt: number }[]) => {
      for (const { at, sampledAt } of samples) {
        ctx.scrollVelocity.add(at.x, at.y, sampledAt);
        last = at;
        if (ctx.scrollBegun) continue;
        if (Math.hypot(at.x - start.x, at.y - start.y) < SCROLL_SLOP) continue;
        ctx.scrollBegun = true;
        ctx.didCrossPointerSlop = true;
        ctx.cancelTouchHold();
        ctx.reportGestureStart();
        ctx.input.translator.scroll.begin({ x: at.x - start.x, y: at.y - start.y }, "free");
      }
      if (!ctx.scrollBegun) return;
      ctx.input.translator.scroll.change({ x: last.x - start.x, y: last.y - start.y }, ctx.scrollVelocity.velocity());
    },
    endFingerScroll: (allowMomentum: boolean) => {
      if (!ctx.scrollBegun) return;
      ctx.scrollBegun = false;
      ctx.input.translator.scroll.end(ctx.scrollVelocity.velocity(), allowMomentum);
    },
    cancelFingerScroll: () => {
      if (!ctx.scrollBegun) return;
      ctx.scrollBegun = false;
      ctx.input.translator.scroll.cancel();
    },
    /**
     * A wheel delta is already the scroll the OS decided on, so it goes out as it is.
     *
     * The finger path accelerates raw travel, because a finger reports where it is and the curve
     * is what turns that into a scroll. A wheel reports a scroll directly, with macOS's own
     * acceleration already in it: measured, five notches pushed through the finger curve came out
     * as 7500 points, because 500 points in 16ms reads as a flick.
     */
    sendWheelScroll: (dx: number, dy: number) => {
      ctx.input.translator.scroll.wheelScroll(dx, dy);
    },
    /**
     * A wheel has no lift, so the end of a wheel scroll is inferred from silence.
     *
     * Nothing in a wheel stream says the hand stopped: a trackpad's own inertia keeps arriving as
     * ordinary wheel events and a notched wheel simply goes quiet. A timer restarted on every wheel
     * event is therefore the lift. It also means the trackpad's momentum is forwarded as the real
     * `changed` deltas it already is, rather than being re-synthesised here on top of itself.
     */
    armWheelIdle: () => {
      if (ctx.wheelIdleTimer !== 0) window.clearTimeout(ctx.wheelIdleTimer);
      ctx.wheelIdleTimer = window.setTimeout(() => {
        ctx.wheelIdleTimer = 0;
        ctx.input.translator.scroll.wheelEnd();
      }, WHEEL_SCROLL_IDLE_MS);
    },
    /** Close a wheel scroll now, for anything that supersedes it or tears the surface down. */
    endWheelScroll: () => {
      if (ctx.wheelIdleTimer === 0) return;
      window.clearTimeout(ctx.wheelIdleTimer);
      ctx.wheelIdleTimer = 0;
      ctx.input.translator.scroll.wheelEnd();
    },
  };
}
