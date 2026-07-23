"use client";

import { useCallback, useEffect, useRef } from "react";

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

import {
  createGestureSink,
  type GestureActionEvent,
  type GestureEventSink,
} from "@/features/gesture/gesture-sink";
import { ActionTracker } from "@/features/gesture/tracker/action-tracker";
import type { ActionEvent, PatternFrame } from "@/features/gesture/tracker/types";
import type { HandFrameListener } from "@/features/gesture/use-gesture-tracking";
import { useGestureStore } from "@/stores/gesture-store";

export interface GestureSessionController {
  /** Begin a fresh detection session (resets the tracker). */
  start: () => Promise<void>;
  /** End the session and reset the tracker. */
  stop: () => void;
  /** Anchor the tracker to the latest hand pose. */
  setAnchor: () => void;
  /** Zero the left/right swipe counts. */
  resetCounts: () => void;
  /** Feed one hand (or null when none) to the local tracker. */
  sendFrame: HandFrameListener;
}

/** Seconds since navigation start; matches the tracker's monotonic clock. */
function nowSeconds(): number {
  return performance.now() / 1000;
}

/** Derive the Space step from a swipe label (-1 LEFT, +1 RIGHT). */
function actionEventToSink(event: ActionEvent): GestureActionEvent {
  const delta = event.label === "LEFT SWIPE" ? -1 : 1;
  return {
    label: event.label,
    delta,
    confidence: event.confidence,
    createdAt: event.createdAt,
  };
}

/**
 * Runs the swipe tracker client-side and routes its output two ways: the
 * gesture store (local UI momentum) and the injected `GestureEventSink` (which,
 * when embedded in the native host, posts a Space step over the bridge; in a
 * plain browser it is a no-op). Views stay dumb — they call start/stop and read
 * the store.
 *
 * This replaced the old backend WebSocket: detection now lives in the webview,
 * so the same bundle drives both the browser app and the embedded panel.
 */
export function useGestureSession(): GestureSessionController {
  const trackerRef = useRef<ActionTracker>(new ActionTracker());
  const sinkRef = useRef<GestureEventSink | null>(null);
  const latestFrameRef = useRef<PatternFrame | null>(null);

  if (sinkRef.current === null) {
    sinkRef.current = createGestureSink();
  }

  /** Push the tracker's current display state into the store. */
  const syncStore = useCallback((now: number) => {
    const tracker = trackerRef.current;
    const [headline] = tracker.headline(now);
    useGestureStore.getState().setAction({
      phase: tracker.phase,
      leftCount: tracker.leftSwipeCount,
      rightCount: tracker.rightSwipeCount,
      anchorSet: tracker.anchor !== null,
      headline,
      // The anchor-ellipse overlay is a later visual; null is a valid store
      // value the overlay already tolerates.
      anchor: null,
    });
  }, []);

  const start = useCallback(async () => {
    trackerRef.current = new ActionTracker();
    latestFrameRef.current = null;
    useGestureStore.getState().setSessionError(null);
    syncStore(nowSeconds());
  }, [syncStore]);

  const stop = useCallback(() => {
    trackerRef.current = new ActionTracker();
    latestFrameRef.current = null;
    syncStore(nowSeconds());
  }, [syncStore]);

  const setAnchor = useCallback(() => {
    const frame = latestFrameRef.current;
    if (frame === null) return;
    trackerRef.current.setAnchor(frame, nowSeconds());
    syncStore(nowSeconds());
  }, [syncStore]);

  const resetCounts = useCallback(() => {
    trackerRef.current.resetCount();
    syncStore(nowSeconds());
  }, [syncStore]);

  const sendFrame = useCallback(
    (hand: NormalizedLandmark[] | null) => {
      const now = nowSeconds();
      if (hand === null) {
        trackerRef.current.markNoHand();
        latestFrameRef.current = null;
        syncStore(now);
        return;
      }

      // Mirror x (1 - x) to match the native flipped-camera convention the
      // tracker was tuned on, then feed the full 21-landmark frame.
      const frame = hand.map(
        (point) => [1 - point.x, point.y] as const,
      ) as PatternFrame;
      latestFrameRef.current = frame;

      const event = trackerRef.current.update(frame, now);
      if (event !== null) {
        const at = performance.now();
        useGestureStore.getState().recordSwipe(event.label === "LEFT SWIPE" ? -1 : 1, at);
        setTimeout(() => useGestureStore.getState().clearSwipe(at), 900);
        sinkRef.current?.emitAction(actionEventToSink(event));
      }
      syncStore(now);
    },
    [syncStore],
  );

  // Reset the tracker if the owning component unmounts mid-session.
  useEffect(() => stop, [stop]);

  return { start, stop, setAnchor, resetCounts, sendFrame };
}
