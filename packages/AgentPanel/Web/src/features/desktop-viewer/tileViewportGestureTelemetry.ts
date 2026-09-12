// What one gesture reports: when it started, what the view did to it, and how it ended.
//
// Bounded here rather than at each handler, because the same three questions are asked of
// a pointer drag, a scroll, a view pan and a pinch, and only one thing knows which is
// running.

import type { ViewportGestureKind, ViewportGestureOutcome } from "@/features/desktop-viewer/TileViewport";
import type { ViewportRuntime } from "@/features/desktop-viewer/tileViewportRuntime";

export function createGestureTelemetry(ctx: ViewportRuntime) {
  return {
    rounded: (value: number) => Math.round(value * 1_000) / 1_000,
    gestureDetail: (outcome?: ViewportGestureOutcome) => ({
      kind: ctx.activeGesture!.kind,
      scale: ctx.rounded(ctx.view.telemetry().scale),
      tx: ctx.rounded(ctx.view.telemetry().tx),
      ty: ctx.rounded(ctx.view.telemetry().ty),
      ...(outcome ? { outcome } : {}),
      ...((ctx.activeGesture!.kind === "pointer" || ctx.activeGesture!.kind === "scroll") && outcome
        ? {
            inputAccepted: ctx.gestureInputAccepted,
            ...(ctx.activeGesture!.kind === "pointer" ? { edgeFollowed: ctx.gestureEdgeFollowed } : {}),
          }
        : {}),
    }),
    reportGestureStart: () => {
      if (!ctx.activeGesture || ctx.activeGesture.startReported) return;
      ctx.activeGesture.startReported = true;
      ctx.gestureTelemetryRef.current?.({
        gestureId: ctx.activeGesture.id,
        phase: "viewport-gesture-start",
        elapsedMs: 0,
        detail: ctx.gestureDetail(),
      });
    },
    startGesture: (kind: ViewportGestureKind) => {
      const now = performance.now();
      ctx.activeGesture = {
        id: crypto.randomUUID(),
        kind,
        startedAt: now,
        startReported: false,
      };
      ctx.gestureInputAccepted = true;
      ctx.gestureTransformed = false;
      ctx.gestureEdgeFollowed = false;
      // Multi-touch is meaningful from the second finger down. One-finger
      // candidates stay quiet until they move, keeping taps to one log event.
      if (kind === "pinch-pan") ctx.reportGestureStart();
    },
    finishGesture: (outcome: ViewportGestureOutcome) => {
      if (!ctx.activeGesture) return;
      if (outcome === "superseded" && !ctx.activeGesture.startReported) {
        ctx.activeGesture = null;
        return;
      }
      ctx.gestureTelemetryRef.current?.({
        gestureId: ctx.activeGesture.id,
        phase: "viewport-gesture-end",
        elapsedMs: Math.max(0, Math.round(performance.now() - ctx.activeGesture.startedAt)),
        detail: ctx.gestureDetail(outcome),
      });
      ctx.activeGesture = null;
    },
  };
}
