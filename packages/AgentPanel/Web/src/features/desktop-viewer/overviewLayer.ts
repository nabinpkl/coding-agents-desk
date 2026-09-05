import { useSyncExternalStore } from "react";

/**
 * Whether crop-based zoom runs a coarse whole-display stream underneath the sharp cropped one.
 *
 * The DeskZoom viewer always does: it is what a pan past the sharp region shows instead of the
 * viewport's bare edge, and what makes waiting for a re-aim acceptable. Here it costs a second
 * capture and a second encoder of the same display, so it is a switch, kept beside the zoom-mode
 * switch so the two-stream cost can be measured on the same desk rather than assumed.
 */
const STORAGE_KEY = "agentdesk.desktop.overviewLayer";

function restore(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

let current = restore();
const listeners = new Set<() => void>();

export function getOverviewLayer(): boolean {
  return current;
}

export function setOverviewLayer(next: boolean): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
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

/** Re-renders only the caller when the switch changes. */
export function useOverviewLayer(): boolean {
  return useSyncExternalStore(subscribe, getOverviewLayer, getOverviewLayer);
}
