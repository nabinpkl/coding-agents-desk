import { useSyncExternalStore } from "react";
import { CAPTURE_SCALE_MAX, CAPTURE_SCALE_MIN } from "../tile-stream/TileStreamRtc";

/**
 * The capture-resolution multiplier, held outside the component tree.
 *
 * It is produced by a control in the viewer's chrome and consumed by the stream inside the viewer's
 * picture -- siblings, so passing it as a prop meant storing it in their common ancestor, and every
 * change re-rendered the whole viewer to deliver it. That is more than waste: `TileViewport` keeps
 * its zoom, pan and remote-cursor position inside an effect, so a re-render that disturbs that
 * effect's inputs resets the view. Subscribing instead means a resolution change re-renders the one
 * component that needs it and nothing above it moves.
 */
const STORAGE_KEY = "agentdesk.desktop.captureScale";

function clamp(value: number): number {
  return Math.min(CAPTURE_SCALE_MAX, Math.max(CAPTURE_SCALE_MIN, value));
}

function restore(): number {
  try {
    const stored = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "");
    return Number.isFinite(stored) ? clamp(stored) : 1;
  } catch {
    return 1;
  }
}

let current = restore();
const listeners = new Set<() => void>();

export function getCaptureScale(): number {
  return current;
}

export function setCaptureScale(value: number): void {
  const next = clamp(value);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // a private window still gets the choice for this session
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders only the caller when the multiplier changes. */
export function useCaptureScale(): number {
  return useSyncExternalStore(subscribe, getCaptureScale, getCaptureScale);
}
