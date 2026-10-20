import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

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

const store = createStore<{ on: boolean }>(() => ({ on: restore() }));

export function getOverviewLayer(): boolean {
  return store.getState().on;
}

export function setOverviewLayer(next: boolean): void {
  if (next === getOverviewLayer()) return;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // a private window still gets the choice for this session
  }
  store.setState({ on: next });
}

/** Re-renders only the caller when the switch changes. */
export function useOverviewLayer(): boolean {
  return useStore(store, (state) => state.on);
}
