/**
 * The two frame helpers the tracker needs, ported from
 * `src/interaction_agent/gesture/patterns.py`. Only these two are used on the
 * detection hot path; the rest of patterns.py is pattern-recording I/O and does
 * not belong in the browser.
 */

import type { PatternFrame, Point } from "./types";

const PALM_POINTS = [0, 5, 9, 13, 17] as const;

/** Mean of the five palm landmarks. */
export function patternPalmCenter(frame: PatternFrame): Point {
  let x = 0;
  let y = 0;
  for (const index of PALM_POINTS) {
    x += frame[index][0];
    y += frame[index][1];
  }
  return [x / PALM_POINTS.length, y / PALM_POINTS.length];
}

/** Largest bounding-box span, floored at 0.001 so division stays finite. */
export function patternHandScale(frame: PatternFrame): number {
  const xs = frame.map((point) => point[0]);
  const ys = frame.map((point) => point[1]);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return Math.max(spanX, spanY, 0.001);
}
