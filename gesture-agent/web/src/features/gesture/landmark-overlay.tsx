"use client";

import {
  FaceLandmarker,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { useGestureStore } from "@/stores/gesture-store";

/** Colors mirror the native OpenCV overlay (converted from its BGR values). */
const HAND_CONNECTION_COLOR = "rgb(0, 255, 0)";
const HAND_POINT_COLOR = "rgb(255, 0, 0)";
const FACE_CONNECTION_COLOR = "rgb(0, 180, 255)";
const FACE_POINT_COLOR = "rgb(0, 255, 255)";

/** Face landmark indices the native overlay marks with dots. */
const FACE_KEY_POINTS = [1, 33, 61, 199, 263, 291] as const;

/** Anchor near-region colors, brighter while the hand is inside it. */
const ANCHOR_COLOR = "rgb(90, 210, 120)";
const ANCHOR_NEAR_COLOR = "rgb(150, 255, 190)";

interface Connection {
  start: number;
  end: number;
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  connections: readonly Connection[],
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (const { start, end } of connections) {
    const from = landmarks[start];
    const to = landmarks[end];
    if (from === undefined || to === undefined) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(from.x * ctx.canvas.width, from.y * ctx.canvas.height);
    ctx.lineTo(to.x * ctx.canvas.width, to.y * ctx.canvas.height);
    ctx.stroke();
  }
}

function drawPoint(
  ctx: CanvasRenderingContext2D,
  landmark: NormalizedLandmark,
  color: string,
  radius: number,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(
    landmark.x * ctx.canvas.width,
    landmark.y * ctx.canvas.height,
    radius,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

/**
 * Draws the latest hand and face landmarks over the video. It reads momentum
 * straight from the gesture store and repaints whenever the frame changes, so
 * it stays a dumb, self-contained renderer with no lifecycle of its own.
 *
 * The canvas is intrinsically sized to the source video and stretched by CSS to
 * cover its parent. Mirroring is applied by the parent via CSS transform, so
 * landmarks are drawn directly in normalized video space here.
 */
export function LandmarkOverlay({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useGestureStore((state) => state.frame);
  const videoSize = useGestureStore((state) => state.videoSize);
  const anchor = useGestureStore((state) => state.action.anchor);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    // On stop the store clears videoSize; wipe the canvas so the last frame's
    // landmarks do not linger painted underneath the idle overlay.
    if (videoSize === null) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (canvas.width !== videoSize.width || canvas.height !== videoSize.height) {
      canvas.width = videoSize.width;
      canvas.height = videoSize.height;
    }

    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / 640;

    if (anchor) {
      // The backend anchor is in mirrored coords; landmarks draw in raw coords
      // and the parent CSS-mirrors the whole canvas, so un-mirror x to align.
      const cx = (1 - anchor.centerX) * canvas.width;
      const cy = anchor.centerY * canvas.height;
      const color = anchor.near ? ANCHOR_NEAR_COLOR : ANCHOR_COLOR;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(2, (anchor.near ? 3 : 2) * scale);
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy,
        anchor.radiusX * canvas.width,
        anchor.radiusY * canvas.height,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      const dot = Math.max(3, 2.5 * scale);
      ctx.beginPath();
      ctx.arc(cx, cy, dot, 0, Math.PI * 2);
      ctx.fill();
      const arm = Math.max(10, 14 * scale);
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy);
      ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm);
      ctx.lineTo(cx, cy + arm);
      ctx.stroke();
    }

    for (const face of frame.faces) {
      drawConnections(
        ctx,
        face,
        FaceLandmarker.FACE_LANDMARKS_CONTOURS,
        FACE_CONNECTION_COLOR,
        Math.max(1, scale),
      );
      for (const index of FACE_KEY_POINTS) {
        const point = face[index];
        if (point !== undefined) {
          drawPoint(ctx, point, FACE_POINT_COLOR, Math.max(2, 2.5 * scale));
        }
      }
    }

    for (const hand of frame.hands) {
      drawConnections(
        ctx,
        hand,
        HandLandmarker.HAND_CONNECTIONS,
        HAND_CONNECTION_COLOR,
        Math.max(2, 2 * scale),
      );
      for (const point of hand) {
        drawPoint(ctx, point, HAND_POINT_COLOR, Math.max(3, 3 * scale));
      }
    }
  }, [frame, videoSize, anchor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}
