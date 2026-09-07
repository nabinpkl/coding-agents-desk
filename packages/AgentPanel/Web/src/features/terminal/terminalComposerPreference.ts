/**
 * Whether the composer types into the session's own terminal rather than into its field, remembered
 * across visits.
 *
 * Global rather than per-session: it is a preference about how you like to type, not a property of
 * any one transcript. Held outside React so the choice survives the band being rebuilt, which it is
 * whenever the Feed re-reads a session's status.
 *
 * OFF by default, and it used to be on. That was right while the terminal appeared above the field
 * and cost only space; now it appears INSTEAD of the field, and a default that hides the composer
 * is a default that hides the thing every session has. The argument for the old default -- a
 * terminal nobody finds -- is answered by the toggle sitting beside the field rather than by
 * showing the terminal to everyone.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-panel.terminal-composer";

const listeners = new Set<() => void>();
let shown = load();

function load(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "shown";
  } catch {
    return false;
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
