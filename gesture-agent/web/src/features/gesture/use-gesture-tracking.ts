"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

import { loadGestureLandmarkers } from "@/features/gesture/landmarker";
import type { GestureLandmarkers } from "@/features/gesture/landmarker";
import { EMPTY_GESTURE_FRAME } from "@/features/gesture/types";
import { useCamera } from "@/features/gesture/use-camera";
import { useGestureStore } from "@/stores/gesture-store";

/** Called each processed frame with the primary hand, or null when none. */
export type HandFrameListener = (hand: NormalizedLandmark[] | null) => void;

export interface UseGestureTrackingOptions {
  onHandFrame?: HandFrameListener;
}

export interface UseGestureTrackingResult {
  /** Attach to the `<video>` element the overlay is drawn on top of. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Acquire the camera + models, then run the per-frame detection loop. */
  start: () => Promise<void>;
  /** Halt the loop, release the camera, and return the store to idle. */
  stop: () => void;
}

/** Window (in frames) used to smooth the reported frame rate. */
const FPS_SAMPLE_SIZE = 30;

/**
 * The single owner of the gesture tracking lifecycle. It composes the camera
 * hook, the MediaPipe landmarkers, and a `requestAnimationFrame` loop that runs
 * `detectForVideo` each frame and pushes the results into the gesture store.
 * All business logic lives here; views only call `start`/`stop` and read state.
 *
 * Store setters are reached through `getState()` rather than captured in
 * closures, so the loop and its schedulers stay referentially stable.
 */
export function useGestureTracking(
  options: UseGestureTrackingOptions = {},
): UseGestureTrackingResult {
  const { videoRef, start: startCamera, stop: stopCamera } = useCamera();

  // Reached through a ref so the loop stays referentially stable even as the
  // listener identity changes between renders.
  const onHandFrameRef = useRef<HandFrameListener | undefined>(
    options.onHandFrame,
  );
  useEffect(() => {
    onHandFrameRef.current = options.onHandFrame;
  }, [options.onHandFrame]);

  const landmarkersRef = useRef<GestureLandmarkers | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const startingRef = useRef(false);
  // Bumped by every start() and by stop(); a start whose generation is stale
  // after its await was cancelled mid-flight and must not commit any state.
  const startGenerationRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const frameTimesRef = useRef<number[]>([]);
  const lastFpsEmitRef = useRef(0);

  // The loop re-schedules itself through this ref (kept in sync below) so it
  // never references its own binding directly. `runLoop` is a deferred callback,
  // which is where side effects (`performance.now`, ref reads) belong.
  const runLoopRef = useRef<() => void>(() => {});

  const runLoop = useCallback(() => {
    if (!runningRef.current) {
      return;
    }
    rafRef.current = requestAnimationFrame(runLoopRef.current);

    const video = videoRef.current;
    const landmarkers = landmarkersRef.current;
    if (
      video === null ||
      landmarkers === null ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.currentTime === lastVideoTimeRef.current
    ) {
      return;
    }

    lastVideoTimeRef.current = video.currentTime;
    const timestamp = performance.now();
    const handResult = landmarkers.hand.detectForVideo(video, timestamp);
    const faceResult = landmarkers.face.detectForVideo(video, timestamp);

    const store = useGestureStore.getState();
    store.setFrame({
      hands: handResult.landmarks,
      handedness: handResult.handedness,
      faces: faceResult.faceLandmarks,
    });

    // Hand off the primary hand (or null) for the action session to stream.
    onHandFrameRef.current?.(handResult.landmarks[0] ?? null);

    const samples = frameTimesRef.current;
    samples.push(timestamp);
    if (samples.length > FPS_SAMPLE_SIZE) {
      samples.shift();
    }
    // Throttle fps writes to ~4/sec: fps recomputes every frame, and writing it
    // to the store each frame would reconcile the whole view at frame rate.
    if (samples.length >= 2 && timestamp - lastFpsEmitRef.current > 250) {
      const elapsed = samples[samples.length - 1] - samples[0];
      if (elapsed > 0) {
        lastFpsEmitRef.current = timestamp;
        store.setFps(((samples.length - 1) / elapsed) * 1000);
      }
    }
  }, [videoRef]);

  useEffect(() => {
    runLoopRef.current = runLoop;
  }, [runLoop]);

  const stop = useCallback(() => {
    // Invalidate any start() still awaiting the camera/model so it cannot
    // resume and re-acquire resources after we have torn down.
    startGenerationRef.current += 1;
    runningRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastVideoTimeRef.current = -1;
    frameTimesRef.current = [];
    stopCamera();
    useGestureStore.getState().reset();
  }, [stopCamera]);

  const start = useCallback(async () => {
    if (runningRef.current || startingRef.current) {
      return;
    }
    startingRef.current = true;
    const generation = (startGenerationRef.current += 1);
    const store = useGestureStore.getState();
    store.setRunState({ status: "requestingCamera" });
    try {
      const [landmarkers] = await Promise.all([
        loadGestureLandmarkers(),
        startCamera(),
      ]);
      // stop() or an unmount ran while we awaited the camera/model. Release the
      // just-acquired stream and bail without scheduling the loop.
      if (generation !== startGenerationRef.current) {
        stopCamera();
        return;
      }
      landmarkersRef.current = landmarkers;

      const video = videoRef.current;
      if (video !== null) {
        store.setVideoSize({
          width: video.videoWidth,
          height: video.videoHeight,
        });
      }

      runningRef.current = true;
      lastVideoTimeRef.current = -1;
      frameTimesRef.current = [];
      lastFpsEmitRef.current = 0;
      store.setFrame(EMPTY_GESTURE_FRAME);
      store.setRunState({ status: "tracking" });
      rafRef.current = requestAnimationFrame(runLoop);
    } catch (error: unknown) {
      stopCamera();
      // Only surface the error if this start is still the active one; a start
      // cancelled by stop() must not clobber the idle state with an error.
      if (generation === startGenerationRef.current) {
        const message =
          error instanceof Error ? error.message : "Failed to start tracking.";
        store.setRunState({ status: "error", message });
      }
    } finally {
      startingRef.current = false;
    }
  }, [startCamera, videoRef, runLoop, stopCamera]);

  useEffect(() => stop, [stop]);

  return { videoRef, start, stop };
}
