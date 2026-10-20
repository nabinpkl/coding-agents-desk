import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { CAPTURE_SCALE_MAX, CAPTURE_SCALE_MIN } from "@/features/desktop-viewer/tile-stream/TileStreamRtc";

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

const store = createStore<{ scale: number }>(() => ({ scale: restore() }));

export function getCaptureScale(): number {
  return store.getState().scale;
}

export function setCaptureScale(value: number): void {
  const next = clamp(value);
  if (next === getCaptureScale()) return;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // a private window still gets the choice for this session
  }
  store.setState({ scale: next });
}

/** Re-renders only the caller when the multiplier changes. */
export function useCaptureScale(): number {
  return useStore(store, (state) => state.scale);
}
