import { create } from "zustand";

import {
  EMPTY_GESTURE_FRAME,
  type GestureAnchor,
  type GestureFrame,
  type GestureRunState,
  type VideoSize,
} from "@/features/gesture/types";

/**
 * Swipe-detection state from the client-side ActionTracker. This is momentum:
 * detection runs locally in the webview and overwrites this every frame.
 */
export interface GestureActionState {
  phase: string;
  leftCount: number;
  rightCount: number;
  anchorSet: boolean;
  headline: string;
  /** Anchor center + near-region ellipse (mirrored coords), or null. */
  anchor: GestureAnchor | null;
}

export const IDLE_ACTION_STATE: GestureActionState = {
  phase: "NO_ANCHOR",
  leftCount: 0,
  rightCount: 0,
  anchorSet: false,
  headline: "ANCHOR NOT SET",
  anchor: null,
};

/** The most recent swipe, kept briefly so the view can flash a direction. */
export interface LastSwipe {
  delta: number;
  at: number;
}

/**
 * Ephemeral "momentum" for the gesture feature: the live run state, the latest
 * landmarks for the current video frame, the measured frame rate, the source
 * video size, and the swipe-detection state from the backend. Nothing here is
 * server truth, so none of it lives in the TanStack Query cache.
 */
interface GestureStore {
  runState: GestureRunState;
  frame: GestureFrame;
  fps: number;
  videoSize: VideoSize | null;
  action: GestureActionState;
  lastSwipe: LastSwipe | null;
  sessionError: string | null;

  setRunState: (runState: GestureRunState) => void;
  setFrame: (frame: GestureFrame) => void;
  setFps: (fps: number) => void;
  setVideoSize: (videoSize: VideoSize | null) => void;
  setAction: (action: GestureActionState) => void;
  recordSwipe: (delta: number, at: number) => void;
  clearSwipe: (at: number) => void;
  setSessionError: (sessionError: string | null) => void;
  reset: () => void;
}

export const useGestureStore = create<GestureStore>((set) => ({
  runState: { status: "idle" },
  frame: EMPTY_GESTURE_FRAME,
  fps: 0,
  videoSize: null,
  action: IDLE_ACTION_STATE,
  lastSwipe: null,
  sessionError: null,

  setRunState: (runState) => set({ runState }),
  setFrame: (frame) => set({ frame }),
  setFps: (fps) => set({ fps }),
  setVideoSize: (videoSize) => set({ videoSize }),
  setAction: (action) => set({ action }),
  recordSwipe: (delta, at) => set({ lastSwipe: { delta, at } }),
  // Clear only if this is still the latest swipe, so a later swipe's flash is
  // not cut short by an earlier one's timer.
  clearSwipe: (at) =>
    set((state) => (state.lastSwipe?.at === at ? { lastSwipe: null } : {})),
  setSessionError: (sessionError) => set({ sessionError }),
  reset: () =>
    set({
      runState: { status: "idle" },
      frame: EMPTY_GESTURE_FRAME,
      fps: 0,
      videoSize: null,
      action: IDLE_ACTION_STATE,
      lastSwipe: null,
      sessionError: null,
    }),
}));
