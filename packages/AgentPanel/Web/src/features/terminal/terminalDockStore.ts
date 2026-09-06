/**
 * Which tmux pane the floating terminal is attached to, held outside React's tree.
 *
 * The terminal has to be mounted somewhere that does not re-render when the Feed reads a status.
 * Measured: mounted inside the composer band it was closed and re-opened every couple of seconds
 * -- `/close` then `POST /api/terminals` in the network log -- and keystrokes typed into the gap
 * reached nothing. Moving it up one level inside the same component tree did not help, because the
 * band's parent re-renders for the same reasons the band does.
 *
 * So the dock lives at the surface shell, beside the tab switcher rather than inside any tab, and
 * the Feed only publishes the pane's NAME here. Nothing the Feed renders can unmount it; only a
 * different pane name or an explicit hide can.
 */
import { useSyncExternalStore } from "react";
import { loadComposerBackend, storeComposerBackend } from "../cli-input/composerBackendStore";

export interface TerminalDock {
  /** The pane to attach to, or null when the selected session is not in one. */
  tmuxSession: string | null;
  /** Whether it is on screen. Remembered across visits through the composer-backend preference. */
  shown: boolean;
}

let state: TerminalDock = { tmuxSession: null, shown: loadComposerBackend() === "terminal" };
const listeners = new Set<() => void>();

function commit(next: TerminalDock): void {
  if (next.tmuxSession === state.tmuxSession && next.shown === state.shown) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Publishes the pane for the selected session.
 *
 * Latched by the caller rather than here: the sidecar's answer goes null between reads, and a dock
 * that followed it would unmount the terminal on every one of them.
 */
export function setTerminalDockPane(tmuxSession: string | null): void {
  commit({ ...state, tmuxSession });
}

export function toggleTerminalDock(): void {
  const shown = !state.shown;
  storeComposerBackend(shown ? "terminal" : "window");
  commit({ ...state, shown });
}

export function useTerminalDock(): TerminalDock {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
