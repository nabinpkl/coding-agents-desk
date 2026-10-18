import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GESTURE_TUNING,
  GESTURE_TUNING_STORAGE_KEY,
  currentGestureTuning,
  useGestureTuning,
  validGestureTuning,
} from "@/features/desktop-viewer/pointer-input/gestureTuning";

afterEach(() => {
  useGestureTuning.getState().resetTuning();
  window.localStorage.removeItem(GESTURE_TUNING_STORAGE_KEY);
});

describe("gesture tuning", () => {
  it("defaults to the Swift client's: everything 1x, natural scrolling off", () => {
    expect(currentGestureTuning()).toEqual(DEFAULT_GESTURE_TUNING);
    expect(DEFAULT_GESTURE_TUNING).toEqual({
      cursorSpeed: 1,
      cursorAcceleration: 1,
      scrollSpeed: 1,
      naturalScrolling: false,
    });
  });

  it("keeps only values a slider could have set", () => {
    expect(
      validGestureTuning({ cursorSpeed: 2, scrollSpeed: 9, cursorAcceleration: "fast", naturalScrolling: 1 }),
    ).toEqual({ ...DEFAULT_GESTURE_TUNING, cursorSpeed: 2 });
    expect(validGestureTuning(null)).toEqual(DEFAULT_GESTURE_TUNING);
  });

  it("refuses an out-of-range change instead of storing it", () => {
    useGestureTuning.getState().setTuning({ cursorSpeed: 0.1, scrollSpeed: 2.5 });
    expect(currentGestureTuning()).toEqual({ ...DEFAULT_GESTURE_TUNING, scrollSpeed: 2.5 });
  });

  it("persists only the four knobs, under a version", () => {
    useGestureTuning.getState().setTuning({ naturalScrolling: true });
    const stored = JSON.parse(window.localStorage.getItem(GESTURE_TUNING_STORAGE_KEY)!);
    expect(stored).toEqual({
      state: { ...DEFAULT_GESTURE_TUNING, naturalScrolling: true },
      version: 1,
    });
  });
});
