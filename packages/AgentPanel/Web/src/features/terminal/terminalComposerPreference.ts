/**
 * Whether the composer shows the session's own terminal, remembered across visits.
 *
 * Global rather than per-session: it is a preference about how you like to type, not a property of
 * any one transcript. Held outside React so the choice survives the band being rebuilt, which it is
 * whenever the Feed re-reads a session's status.
 *
 * On by default. It only renders for a session that HAS a tmux pane, so the default costs nothing
 * where there is nothing to show, and the alternative is a terminal nobody finds.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

const listeners = new Set<() => void>();
let shown = load();

function load(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

export function toggleTerminalComposer(): void {
  shown = !shown;
  try {
    localStorage.setItem(STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    /* storage disabled */
  }
  for (const listener of listeners) listener();
}

export function useTerminalComposerShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
    () => shown,
  );
}
