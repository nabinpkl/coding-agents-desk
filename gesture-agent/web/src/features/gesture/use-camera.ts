"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

export interface UseCameraResult {
  /** Attach to a `<video>` element; the hook owns its `srcObject`. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * Requests the webcam, binds the stream to the video element, and resolves
   * once the first frame is decodable. Throws (fail loud) on denial or absence.
   */
  start: () => Promise<void>;
  /** Stops all tracks and detaches the stream. Safe to call when idle. */
  stop: () => void;
}

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: "user",
  },
  audio: false,
};

/**
 * Owns webcam acquisition and playback for a single video element. It deals
 * only with the media stream lifecycle; landmark inference lives elsewhere.
 */
export function useCamera(): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video !== null) {
      video.srcObject = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose a camera (getUserMedia).");
    }
    const video = videoRef.current;
    if (video === null) {
      throw new Error("Camera video element is not mounted.");
    }

    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    streamRef.current = stream;
    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The camera stream failed to load."));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("error", onError);
    });

    await video.play();
  }, []);

  useEffect(() => stop, [stop]);

  return { videoRef, start, stop };
}
