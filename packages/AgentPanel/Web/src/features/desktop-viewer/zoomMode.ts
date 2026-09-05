import { useSyncExternalStore } from "react";

/**
 * How the viewer zooms, held outside the component tree so the chrome can switch it and the
 * viewport can read it without their common ancestor re-rendering.
 *
 * `css` magnifies the picture of the whole display with a transform: instant, and blurred past
 * the detail the capture was made at. `crop` re-aims the capture at the part being looked at,
 * ported from the DeskZoom viewer: sharp at any zoom the display can supply, at the cost of a
 * renegotiation once each gesture settles. Both stay selectable so they can be compared on the
 * same desk; the default is the one that has been in use.
 */
export type ZoomMode = "css" | "crop";

const STORAGE_KEY = "agentdesk.desktop.zoomMode";

function restore(): ZoomMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "crop" ? "crop" : "css";
  } catch {
    return "css";
  }
}

let current: ZoomMode = restore();
const listeners = new Set<() => void>();

export function getZoomMode(): ZoomMode {
  return current;
}

export function setZoomMode(next: ZoomMode): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
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

/** Re-renders only the caller when the mode changes. */
export function useZoomMode(): ZoomMode {
  return useSyncExternalStore(subscribe, getZoomMode, getZoomMode);
}
