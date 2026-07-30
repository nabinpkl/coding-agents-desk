import type { EventMode } from "./data-source/AgentDataSource";

const STORAGE_KEY = "agent-panel.thread.mode";

/**
 * The view to open a thread in, remembered across sessions.
 *
 * Global rather than per-thread: it is a reading preference, not a property of any
 * one transcript, and a viewer who prefers the raw view should not have to say so
 * again in every thread they open.
 *
 * `nice` is the default. It omits harness machinery, which is 42% of a Claude
 * transcript and 26% of a Codex one here, and the raw view stays one press away as
 * the fidelity guarantee.
 */
export const DEFAULT_EVENT_MODE: EventMode = "nice";

export function loadEventMode(): EventMode {
  if (typeof window === "undefined") return DEFAULT_EVENT_MODE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Validated against the set rather than cast: a stale or hand-edited value would
    // otherwise travel to the sidecar, which rejects an unknown mode, and the thread
    // would fail to load with no way to recover from inside the panel.
    return raw === "raw" || raw === "nice" ? raw : DEFAULT_EVENT_MODE;
  } catch {
    return DEFAULT_EVENT_MODE;
  }
}

export function storeEventMode(mode: EventMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage disabled */
  }
}
