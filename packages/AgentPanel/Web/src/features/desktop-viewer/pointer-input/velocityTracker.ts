// A finger's velocity, estimated from where it has been rather than from one step.
//
// UIKit hands a recognizer `velocity(in:)`, already smoothed. A browser hands positions and
// times, and the obvious estimate -- the last step over the last gap -- swings with every
// uneven sample. That swing is what decided the momentum of a flick before this existed.

import { VELOCITY_WINDOW_MS } from "@/features/desktop-viewer/pointer-input/gestureConstants";

export interface Velocity {
  x: number;
  y: number;
}

export const STILL: Velocity = { x: 0, y: 0 };

interface Sample {
  x: number;
  y: number;
  /** Milliseconds, on whatever clock the caller uses for every sample. */
  at: number;
}

export class VelocityTracker {
  private samples: Sample[] = [];

  reset(): void {
    this.samples = [];
  }

  add(x: number, y: number, at: number): void {
    this.samples.push({ x, y, at });
    const oldest = at - VELOCITY_WINDOW_MS;
    // Keep one sample older than the window so the span reaches back the whole window.
    while (this.samples.length > 2 && this.samples[1]!.at <= oldest) this.samples.shift();
  }

  /** Points per second over the window. Still until there are two samples to compare. */
  velocity(): Velocity {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || first === last) return STILL;
    const seconds = Math.max((last.at - first.at) / 1_000, 0.001);
    return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds };
  }
}
