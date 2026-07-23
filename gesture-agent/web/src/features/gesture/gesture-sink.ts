/**
 * Where committed swipes go once the client-side tracker detects them.
 *
 * The webview always drives its own UI from the gesture store; the sink is only
 * for events that must cross into the native host — a macOS Space step. Two
 * implementations, chosen by environment: embedded posts to the native
 * InteractionPanel handler, browser/dev is a no-op (nothing native to step).
 *
 * This is the injected seam that lets `useGestureSession` (Phase 1) run the
 * same tracker in both the browser and the embedded webview, differing only in
 * where the resulting action lands.
 */

import { INTERACTION_HANDLER, isEmbedded, postToHost } from "@/lib/host-bridge";

/**
 * One committed swipe from the tracker. Mirrors the Python `ActionEvent`
 * (label / confidence / created_at); `delta` is the derived Space step
 * (-1 LEFT, +1 RIGHT), matching the host's `NormalizedInput.switchSpaceStep`
 * contract so the native side needs no translation.
 */
export interface GestureActionEvent {
  label: "LEFT SWIPE" | "RIGHT SWIPE";
  delta: -1 | 1;
  confidence: number;
  createdAt: number;
}

/** Sink for committed gestures that must reach the native host. */
export interface GestureEventSink {
  emitAction(event: GestureActionEvent): void;
}

/** Embedded: post the Space step to the native InteractionPanel handler. */
export class BridgeGestureSink implements GestureEventSink {
  constructor(private readonly handler: string = INTERACTION_HANDLER) {}

  emitAction(event: GestureActionEvent): void {
    postToHost(this.handler, { t: "spaceStep", delta: event.delta });
  }
}

/** Browser / dev: no native host to notify. The store still drives the UI. */
export class DevGestureSink implements GestureEventSink {
  emitAction(): void {
    // Intentionally empty: a plain browser has no macOS Space to step.
  }
}

/** Pick the sink for the current environment. */
export function createGestureSink(): GestureEventSink {
  return isEmbedded() ? new BridgeGestureSink() : new DevGestureSink();
}
