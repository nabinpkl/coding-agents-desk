// A translator with nothing real under it: outputs recorded, frames queued, time given by hand.
//
// The Swift translator's tests drive it through its `process*` seams with no UIKit running; this
// is the same seam for the TypeScript twin, so those tests can be replayed vector for vector.

import {
  GestureTranslator,
  IDENTITY_GAIN,
  type GestureOutput,
} from "@/features/desktop-viewer/pointer-input/gestureTranslator";
import { DEFAULT_GESTURE_TUNING, type GestureTuning } from "@/features/desktop-viewer/pointer-input/gestureTuning";

export function translatorTestKit(
  options: {
    tuning?: Partial<GestureTuning>;
    /** True for the shipped curves; the Swift vectors ran with none. */
    accelerated?: boolean;
    refuse?: (output: GestureOutput) => boolean;
  } = {},
) {
  const outputs: GestureOutput[] = [];
  const frames = new Map<number, (now: number) => void>();
  let nextFrame = 1;
  let clock = 0;
  const tuning = { ...DEFAULT_GESTURE_TUNING, ...options.tuning };
  const translator = new GestureTranslator({
    emit: (output) => {
      if (options.refuse?.(output)) return false;
      outputs.push(output);
      return true;
    },
    frames: {
      request: (callback) => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        frames.delete(handle);
      },
    },
    now: () => clock,
    tuning: () => tuning,
    ...(options.accelerated ? {} : { pointerGain: IDENTITY_GAIN, scrollGain: IDENTITY_GAIN }),
  });
  return {
    translator,
    outputs,
    /** Moves the clock, in milliseconds. */
    setNow: (ms: number) => {
      clock = ms;
    },
    /** Runs every frame queued so far at `now`, as one display refresh would. */
    runFrames: (now = clock) => {
      clock = now;
      const due = [...frames.entries()];
      frames.clear();
      for (const [, callback] of due) callback(now);
    },
    pendingFrames: () => frames.size,
  };
}
