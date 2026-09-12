// Scrolling: what a frame coalesces, the momentum a flick leaves behind, and the wheel
// events that go to the Mac instead of moving the view.

import {
  SCROLL_MOMENTUM_DECAY_K,
  SCROLL_MOMENTUM_FLICK_THRESHOLD,
  SCROLL_MOMENTUM_STOP_THRESHOLD,
  WHEEL_SCROLL_IDLE_MS,
} from "./tileViewportConstants";
import { scrollAccelerationGain } from "./tileViewportMath";
import type { ViewportRuntime } from "./tileViewportRuntime";

export function createScrolling(ctx: ViewportRuntime) {
  return {
    flushScroll: (now = performance.now()) => {
      ctx.scrollFrame = 0;
      if (ctx.pendingScrollDx === 0 && ctx.pendingScrollDy === 0) return;
      const dx = ctx.pendingScrollDx;
      const dy = ctx.pendingScrollDy;
      ctx.pendingScrollDx = 0;
      ctx.pendingScrollDy = 0;
      const elapsed = Math.max((now - ctx.lastScrollFrameAt) / 1_000, 0.001);
      ctx.lastScrollFrameAt = now;
      const gain = scrollAccelerationGain(Math.hypot(dx, dy) / elapsed);
      // Deliberately matches the native client's current LinearMouse-calibrated default:
      // raw finger deltas pass through with the same sign on both axes.
      ctx.gestureInputAccepted = ctx.send({
        type: "scroll",
        dx: dx * gain,
        dy: dy * gain,
        phase: ctx.scrollActive ? "changed" : "began",
      }) && ctx.gestureInputAccepted;
      ctx.scrollActive = true;
    },
    scheduleScrollFlush: () => {
      if (ctx.scrollFrame !== 0) return;
      ctx.scrollFrame = window.requestAnimationFrame(ctx.flushScroll);
    },
    stopMomentum: (emitEnd: boolean) => {
      const wasRunning = ctx.momentumFrame !== 0;
      if (ctx.momentumFrame !== 0) window.cancelAnimationFrame(ctx.momentumFrame);
      ctx.momentumFrame = 0;
      ctx.momentumVelocity = { x: 0, y: 0 };
      if (emitEnd && wasRunning && ctx.didEmitMomentumBegan) {
        ctx.gestureInputAccepted = ctx.send({
          type: "scroll", dx: 0, dy: 0, phase: "momentumEnded",
        }) && ctx.gestureInputAccepted;
      }
      ctx.didEmitMomentumBegan = false;
    },
    tickMomentum: (now: number) => {
      ctx.momentumFrame = 0;
      const elapsed = Math.max((now - ctx.momentumLastTime) / 1_000, 0.001);
      ctx.momentumLastTime = now;
      const decay = Math.exp(-SCROLL_MOMENTUM_DECAY_K * elapsed);
      ctx.momentumVelocity = {
        x: ctx.momentumVelocity.x * decay,
        y: ctx.momentumVelocity.y * decay,
      };
      const speed = Math.hypot(ctx.momentumVelocity.x, ctx.momentumVelocity.y);
      if (speed < SCROLL_MOMENTUM_STOP_THRESHOLD) {
        if (ctx.didEmitMomentumBegan) {
          ctx.gestureInputAccepted = ctx.send({
            type: "scroll", dx: 0, dy: 0, phase: "momentumEnded",
          }) && ctx.gestureInputAccepted;
        }
        ctx.didEmitMomentumBegan = false;
        return;
      }
      const gain = scrollAccelerationGain(speed);
      ctx.gestureInputAccepted = ctx.send({
        type: "scroll",
        dx: ctx.momentumVelocity.x * elapsed * gain,
        dy: ctx.momentumVelocity.y * elapsed * gain,
        phase: ctx.didEmitMomentumBegan ? "momentumChanged" : "momentumBegan",
      }) && ctx.gestureInputAccepted;
      ctx.didEmitMomentumBegan = true;
      ctx.momentumFrame = window.requestAnimationFrame(ctx.tickMomentum);
    },
    startMomentum: (velocity: { x: number; y: number }) => {
      ctx.stopMomentum(false);
      ctx.momentumVelocity = velocity;
      ctx.momentumLastTime = performance.now();
      ctx.momentumFrame = window.requestAnimationFrame(ctx.tickMomentum);
    },
    endScroll: (allowMomentum: boolean) => {
      if (ctx.scrollFrame !== 0) window.cancelAnimationFrame(ctx.scrollFrame);
      ctx.scrollFrame = 0;
      ctx.flushScroll();
      if (ctx.scrollActive) {
        ctx.gestureInputAccepted = ctx.send({
          type: "scroll", dx: 0, dy: 0, phase: "ended",
        }) && ctx.gestureInputAccepted;
      }
      const liftVelocity = ctx.lastScrollVelocity;
      ctx.scrollActive = false;
      ctx.pendingScrollDx = 0;
      ctx.pendingScrollDy = 0;
      ctx.lastScrollVelocity = { x: 0, y: 0 };
      if (allowMomentum && Math.hypot(liftVelocity.x, liftVelocity.y) >= SCROLL_MOMENTUM_FLICK_THRESHOLD) {
        ctx.startMomentum(liftVelocity);
      }
    },
    /**
     * A wheel delta is already the scroll the OS decided on, so it goes out as it is.
     *
     * The finger path accumulates raw travel and accelerates it at flush time, because a finger
     * reports where it is and the curve is what turns that into a scroll. A wheel reports a scroll
     * directly, with macOS's own acceleration already in it, and it arrives whole inside one
     * frame: measured, five notches pushed through the finger curve came out as 7500 points,
     * because 500 points in 16ms reads as a flick. Sending each event as it lands also keeps the
     * wheel off the animation frame, which a hidden or throttled tab never runs.
     */
    sendWheelScroll: (dx: number, dy: number) => {
      ctx.gestureInputAccepted = ctx.send({
        type: "scroll",
        dx,
        dy,
        phase: ctx.scrollActive ? "changed" : "began",
      }) && ctx.gestureInputAccepted;
      ctx.scrollActive = true;
    },
    /**
     * A wheel has no lift, so the end of a wheel scroll is inferred from silence.
     *
     * The finger path closes its scroll on pointerup, and the Mac needs that `ended` to close the
     * phase the first delta opened. Nothing in a wheel stream says the hand stopped: a trackpad's
     * own inertia keeps arriving as ordinary wheel events and a notched wheel simply goes quiet.
     * A timer restarted on every wheel event is therefore the lift. It also means the trackpad's
     * momentum is forwarded as the real `changed` deltas it already is, rather than being thrown
     * away and re-synthesised here on top of itself.
     */
    armWheelIdle: () => {
      if (ctx.wheelIdleTimer !== 0) window.clearTimeout(ctx.wheelIdleTimer);
      ctx.wheelIdleTimer = window.setTimeout(() => {
        ctx.wheelIdleTimer = 0;
        ctx.endScroll(false);
      }, WHEEL_SCROLL_IDLE_MS);
    },
    /** Close a wheel scroll now, for anything that supersedes it or tears the surface down. */
    endWheelScroll: () => {
      if (ctx.wheelIdleTimer === 0) return;
      window.clearTimeout(ctx.wheelIdleTimer);
      ctx.wheelIdleTimer = 0;
      ctx.endScroll(false);
    },
  };
}
