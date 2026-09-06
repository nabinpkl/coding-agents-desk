/**
 * Which tmux pane the floating terminal is attached to, held outside React's tree.
 *
 * The terminal has to be mounted somewhere that does not re-render when the Feed reads a status.
 * Measured: mounted inside the composer band it was closed and re-opened every couple of seconds
 * -- `/close` then `POST /api/terminals` in the network log -- because `useCliInput` resets its
 * status to idle on every read and the band re-rendered with it.
 *
 * So the dock lives at the surface shell, beside the tab switcher rather than inside any tab, and
 * the Feed only publishes the pane's NAME here. Nothing the Feed renders can unmount it; only a
 * different pane name or an explicit hide can.
 *
 * This churn was real but it was NOT why typing appeared broken. That was the dev server serving
 * HTTP/1.1, which starved the terminals event stream of a connection; see `defaultSidecar` in
 * `vite.config.ts`. Moving the mount fixed the churn and nothing else.
 */
import { useSyncExternalStore } from "react";

/**
 * Global rather than per-session: it is a preference about whether you want a terminal on screen,
 * not a property of any one transcript.
 */
const STORAGE_KEY = "agent-panel.terminal-dock";

function loadShown(): boolean {
  if (typeof window === "undefined") return true;
  try {
    // Shown by default. The dock only renders for a session that HAS a pane, so the default costs
    // nothing where there is nothing to show, and the alternative is a terminal nobody finds.
    return localStorage.getItem(STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

function storeShown(shown: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    /* storage disabled */
  }
}

export interface TerminalDock {
  /** The pane to attach to, or null when the selected session is not in one. */
  tmuxSession: string | null;
  /** Whether it is on screen. Remembered across visits through the composer-backend preference. */
  shown: boolean;
}

let state: TerminalDock = { tmuxSession: null, shown: loadShown() };
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
  storeShown(shown);
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
