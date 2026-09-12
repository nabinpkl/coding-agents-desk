import { useSyncExternalStore } from "react";
import type { CapturePlan } from "@/features/desktop-viewer/tileCapturePlan";

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
    && next.display.width === current.display.width
    && next.display.height === current.display.height
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

/**
 * When the coarse whole-display stream first painted, or null while it has not.
 *
 * The sharp stream's first request waits on this: the encoder pool measured that two captures of
 * one display started within about 300ms starve one of them, so the second must not start until
 * the first is demonstrably running. The viewer settles again when this fires, which is what
 * turns "not yet" into the request it was holding.
 */
let overviewReadyAt: number | null = null;
const overviewListeners = new Set<() => void>();

export function markOverviewReady(at = performance.now()): void {
  if (overviewReadyAt !== null) return;
  overviewReadyAt = at;
  for (const listener of overviewListeners) listener();
}

export function clearOverviewReady(): void {
  overviewReadyAt = null;
}

/** True once the overview has been painting for at least `forMs`. */
export function overviewReady(forMs: number): boolean {
  return overviewReadyAt !== null && performance.now() - overviewReadyAt >= forMs;
}

export function onOverviewReady(listener: () => void): () => void {
  overviewListeners.add(listener);
  return () => {
    overviewListeners.delete(listener);
  };
}
