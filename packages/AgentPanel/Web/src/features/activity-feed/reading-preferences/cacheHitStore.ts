const STORAGE_KEY = "agent-panel.thread.cache-hits";

/**
 * Whether per-turn prompt-cache badges are shown in the activity feed.
 *
 * A reading preference, remembered across sessions like the event mode: it
 * changes what a transcript row renders, never what the transcript is, so it
 * is purely presentational and the sidecar never hears about it.
 *
 * Off by default: the badge is extra ink on every turn, and a viewer who wants
 * cache accounting opts in per reading session once.
 */
export const DEFAULT_CACHE_HITS_VISIBLE = false;

export function loadCacheHitsVisible(): boolean {
  if (typeof window === "undefined") return DEFAULT_CACHE_HITS_VISIBLE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "true";
  } catch {
    return DEFAULT_CACHE_HITS_VISIBLE;
  }
}

export function storeCacheHitsVisible(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? "true" : "false");
  } catch {
    /* storage disabled */
  }
}
