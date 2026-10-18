// How this reader tuned a finger: pointer speed, acceleration, scroll speed, and which way
// "natural" scrolling goes.
//
// `GestureTuning` in the Swift client, same four knobs and same defaults. Stored because it is a
// preference the reader set by hand and would have to set again after every reload; persisted
// with zustand's `persist` so a changed shape is migrated rather than silently dropped
// (ADR-0114). Every field is validated on the way in, so a stale or hand-edited value falls back
// to the default instead of becoming a speed nobody chose.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface GestureTuning {
  /** Multiplies pointer travel. */
  cursorSpeed: number;
  /** Multiplies the acceleration curve's gain, so it shapes fast flicks more than slow drags. */
  cursorAcceleration: number;
  /** Multiplies scroll travel and the coast after it. */
  scrollSpeed: number;
  /**
   * Content follows the finger. Off by default: this drives a Mac, where the finger does the job
   * a wheel does. Named for what it turns on, since "invert" has to be read against a baseline
   * people disagree about.
   */
  naturalScrolling: boolean;
}

export const DEFAULT_GESTURE_TUNING: GestureTuning = Object.freeze({
  cursorSpeed: 1,
  cursorAcceleration: 1,
  scrollSpeed: 1,
  naturalScrolling: false,
});

/** The Swift settings sliders' range. */
export const TUNING_MIN = 0.5;
export const TUNING_MAX = 3;
export const GESTURE_TUNING_STORAGE_KEY = "agentdesk.desktop-gesture-tuning";

function multiplier(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= TUNING_MIN && value <= TUNING_MAX
    ? value
    : fallback;
}

/** Anything at all, made into a tuning: each field kept only when it is one a slider could set. */
export function validGestureTuning(value: unknown): GestureTuning {
  const stored = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    cursorSpeed: multiplier(stored.cursorSpeed, DEFAULT_GESTURE_TUNING.cursorSpeed),
    cursorAcceleration: multiplier(stored.cursorAcceleration, DEFAULT_GESTURE_TUNING.cursorAcceleration),
    scrollSpeed: multiplier(stored.scrollSpeed, DEFAULT_GESTURE_TUNING.scrollSpeed),
    naturalScrolling:
      typeof stored.naturalScrolling === "boolean" ? stored.naturalScrolling : DEFAULT_GESTURE_TUNING.naturalScrolling,
  };
}

interface GestureTuningStore extends GestureTuning {
  setTuning: (change: Partial<GestureTuning>) => void;
  resetTuning: () => void;
}

export const useGestureTuning = create<GestureTuningStore>()(
  persist(
    (set) => ({
      ...DEFAULT_GESTURE_TUNING,
      setTuning: (change) => set((current) => validGestureTuning({ ...current, ...change })),
      resetTuning: () => set({ ...DEFAULT_GESTURE_TUNING }),
    }),
    {
      name: GESTURE_TUNING_STORAGE_KEY,
      version: 1,
      // A private window and a container without storage both throw; the tuning then lives for the
      // session only, which is what an unwritable store can offer.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ cursorSpeed, cursorAcceleration, scrollSpeed, naturalScrolling }) => ({
        cursorSpeed,
        cursorAcceleration,
        scrollSpeed,
        naturalScrolling,
      }),
      merge: (persisted, current) => ({ ...current, ...validGestureTuning(persisted) }),
    },
  ),
);

/** The tuning as it is right now, for code that reads it per event rather than per render. */
export function currentGestureTuning(): GestureTuning {
  const { cursorSpeed, cursorAcceleration, scrollSpeed, naturalScrolling } = useGestureTuning.getState();
  return { cursorSpeed, cursorAcceleration, scrollSpeed, naturalScrolling };
}
