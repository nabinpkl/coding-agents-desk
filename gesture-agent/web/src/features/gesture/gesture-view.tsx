"use client";

import {
  Anchor,
  Camera,
  CircleStop,
  Gauge,
  Hand,
  LoaderCircle,
  MoveLeft,
  MoveRight,
  RotateCcw,
  ScanFace,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LandmarkOverlay } from "@/features/gesture/landmark-overlay";
import type { GestureRunState } from "@/features/gesture/types";
import { useGestureSession } from "@/features/gesture/use-gesture-session";
import { useGestureTracking } from "@/features/gesture/use-gesture-tracking";
import { useGestureStore, type LastSwipe } from "@/stores/gesture-store";

interface StatusBadge {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

function statusBadge(runState: GestureRunState): StatusBadge {
  switch (runState.status) {
    case "idle":
      return { label: "Idle", variant: "outline" };
    case "requestingCamera":
      return { label: "Requesting camera", variant: "secondary" };
    case "tracking":
      return { label: "Tracking", variant: "default" };
    case "error":
      return { label: "Error", variant: "destructive" };
  }
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <div className="flex flex-col leading-tight">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-sm tabular-nums">{value}</span>
      </div>
    </div>
  );
}

/** Big directional flash shown for a beat after each detected swipe. */
function SwipeFlash({ swipe }: { swipe: LastSwipe }) {
  const isLeft = swipe.delta < 0;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="flex items-center gap-3 rounded-2xl bg-black/70 px-6 py-4 text-2xl font-semibold text-white">
        {isLeft ? <MoveLeft className="size-8" /> : null}
        {isLeft ? "LEFT SWIPE" : "RIGHT SWIPE"}
        {isLeft ? null : <MoveRight className="size-8" />}
      </div>
    </div>
  );
}

/**
 * Composition surface for the gesture feature. It wires the tracking hook (local
 * MediaPipe landmarks) and the session hook (landmarks streamed to the backend
 * ActionTracker) to controls, and reads momentum from the store. No inference
 * or detection logic lives here.
 */
export function GestureView() {
  const session = useGestureSession();
  const {
    videoRef,
    start: startTracking,
    stop: stopTracking,
  } = useGestureTracking({ onHandFrame: session.sendFrame });

  const runState = useGestureStore((state) => state.runState);
  const fps = useGestureStore((state) => state.fps);
  const handCount = useGestureStore((state) => state.frame.hands.length);
  const faceCount = useGestureStore((state) => state.frame.faces.length);
  const action = useGestureStore((state) => state.action);
  const lastSwipe = useGestureStore((state) => state.lastSwipe);
  const sessionError = useGestureStore((state) => state.sessionError);

  const start = useCallback(() => {
    void startTracking();
    void session.start();
  }, [session, startTracking]);

  const stop = useCallback(() => {
    session.stop();
    stopTracking();
  }, [session, stopTracking]);

  // Keyboard shortcuts while tracking: A anchors, R resets counts. Reads the
  // run state at press time so the listener never needs re-subscribing.
  const { setAnchor, resetCounts } = session;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      if (useGestureStore.getState().runState.status !== "tracking") return;
      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        setAnchor();
      } else if (key === "r") {
        event.preventDefault();
        resetCounts();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setAnchor, resetCounts]);

  const badge = statusBadge(runState);
  const isTracking = runState.status === "tracking";
  const isActive = isTracking || runState.status === "requestingCamera";
  const isBusy = runState.status === "requestingCamera";

  return (
    <Card className="gap-0 p-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b p-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            Gesture tracking
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </CardTitle>
          <CardDescription>
            Landmarks and swipe detection run locally; swipes step spaces
            left / right.
          </CardDescription>
        </div>
        {isActive ? (
          <Button variant="destructive" onClick={stop} disabled={isBusy}>
            <CircleStop />
            Stop
          </Button>
        ) : (
          <Button onClick={start}>
            <Camera />
            Start camera
          </Button>
        )}
      </CardHeader>

      <CardContent className="p-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
          />
          <LandmarkOverlay className="-scale-x-100 object-cover" />

          {lastSwipe ? <SwipeFlash swipe={lastSwipe} /> : null}

          {isTracking ? (
            <div className="absolute top-3 left-3 rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white">
              {action.headline}
            </div>
          ) : null}

          {runState.status !== "tracking" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-center text-sm text-white">
              {runState.status === "requestingCamera" ? (
                <>
                  <LoaderCircle className="size-6 animate-spin" />
                  <span>Requesting camera and loading models...</span>
                </>
              ) : runState.status === "error" ? (
                <div className="flex max-w-sm flex-col items-center gap-2 px-6">
                  <TriangleAlert className="size-6 text-destructive" />
                  <span>{runState.message}</span>
                </div>
              ) : (
                <>
                  <Camera className="size-6" />
                  <span>Start the camera to track gestures.</span>
                </>
              )}
            </div>
          )}
        </div>

        {isTracking ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={session.setAnchor}>
              <Anchor />
              {action.anchorSet ? "Re-anchor" : "Set anchor"}
              <kbd className="ml-1 rounded border bg-background/60 px-1 font-mono text-[10px] leading-none">
                A
              </kbd>
            </Button>
            <Button variant="outline" onClick={session.resetCounts}>
              <RotateCcw />
              Reset counts
              <kbd className="ml-1 rounded border bg-muted px-1 font-mono text-[10px] leading-none">
                R
              </kbd>
            </Button>
            {!action.anchorSet ? (
              <span className="text-xs text-muted-foreground">
                Hold your open hand still and set an anchor to start detecting
                swipes.
              </span>
            ) : null}
          </div>
        ) : null}

        {sessionError ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-destructive">
            <TriangleAlert className="size-4" />
            {sessionError}
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
          <StatTile
            icon={<Gauge className="size-4" />}
            label="FPS"
            value={fps.toFixed(0)}
          />
          <StatTile
            icon={<Hand className="size-4" />}
            label="Hands"
            value={String(handCount)}
          />
          <StatTile
            icon={<ScanFace className="size-4" />}
            label="Faces"
            value={String(faceCount)}
          />
          <StatTile
            icon={<MoveLeft className="size-4" />}
            label="Left swipes"
            value={String(action.leftCount)}
          />
          <StatTile
            icon={<MoveRight className="size-4" />}
            label="Right swipes"
            value={String(action.rightCount)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
