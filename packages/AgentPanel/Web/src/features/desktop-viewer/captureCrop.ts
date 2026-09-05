import { useSyncExternalStore } from "react";
import type { CapturePlan } from "./tileCapturePlan";

/**
 * The capture plan the stream should be running, held outside the component tree.
 *
 * Same reason `captureScale` lives out here: it is produced by the gesture code inside
 * `TileViewport`'s effect and consumed by the stream rendered as that viewport's child, so routing
 * it through their common ancestor would re-render the viewer on every settled zoom -- and the
 * viewer keeps its view and remote-cursor position inside an effect, so disturbing that effect's
 * inputs resets the view. Subscribing means a new plan re-renders the stream alone.
 *
 * Null means the whole display at the automatic size, which is both the default and what a viewer
 * at zoom 1 wants. Deliberately not persisted: a plan is a place on one particular desktop, and
 * restoring yesterday's rectangle onto a desktop that has since changed shape would open the
 * viewer looking at the wrong place with no way to tell that had happened.
 */
let current: CapturePlan | null = null;
const listeners = new Set<() => void>();

export function getCaptureCrop(): CapturePlan | null {
  return current;
}

/** Same plan means same object, so a subscriber never re-renders, or renegotiates, for no change. */
export function setCaptureCrop(next: CapturePlan | null): void {
  if (next === null ? current === null : current !== null
    && Math.round(next.region.x) === Math.round(current.region.x)
    && Math.round(next.region.y) === Math.round(current.region.y)
    && Math.round(next.region.width) === Math.round(current.region.width)
    && Math.round(next.region.height) === Math.round(current.region.height)
    && next.pixelWidth === current.pixelWidth
    && next.pixelHeight === current.pixelHeight) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders only the caller when the plan changes. */
export function useCaptureCrop(): CapturePlan | null {
  return useSyncExternalStore(subscribe, getCaptureCrop, getCaptureCrop);
}

/**
 * The swap signal: the first frame of the current plan has arrived, so the frame on screen now
 * covers that plan's region and the viewer can place it accordingly.
 *
 * Requesting a plan and showing its result cannot happen at the same moment: the request takes a
 * renegotiation to satisfy, and until the new picture arrives the old frame, covering the old
 * region, is still what is on screen. The viewer keeps placing the old frame by the old region
 * until this fires, which is the DeskZoom viewer's `promote` step: the incoming stream becomes
 * current only once it has produced a frame.
 */
const appliedListeners = new Set<(plan: CapturePlan | null) => void>();

export function onCaptureCropApplied(listener: (plan: CapturePlan | null) => void): () => void {
  appliedListeners.add(listener);
  return () => {
    appliedListeners.delete(listener);
  };
}

export function captureCropApplied(): void {
  for (const listener of appliedListeners) listener(current);
}
