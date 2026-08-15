const STORAGE_KEY = "agent-panel.selection";

/**
 * Which thread was open, remembered across reloads.
 *
 * Identity only, never the `SessionSummary` itself. That record carries live facts -- the activity
 * bin, the last event time, what the session can do -- and a copy of it in storage would be a
 * second source of truth that nothing refreshes. It is stored as three strings and re-resolved
 * against the inventory once the stream delivers it.
 *
 * This exists because the panel is edited while it is being read. A Vite reload throws away every
 * piece of React state, and landing back on "Select a session from Projects" after each save makes
 * the panel unusable to develop against -- and does the same to a phone that was backgrounded long
 * enough for its webview to be discarded.
 */
export interface RememberedSelection {
  projectPath: string;
  source: string;
  sessionId: string;
}

export function loadSelection(): RememberedSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedSelection>;
    // Every field checked rather than cast: a hand-edited or stale-shape value would otherwise
    // become a lookup for a session that cannot exist, and the panel would open on nothing with
    // no way to tell that from a deleted thread.
    if (
      typeof parsed?.projectPath !== "string" || !parsed.projectPath ||
      typeof parsed.source !== "string" || !parsed.source ||
      typeof parsed.sessionId !== "string" || !parsed.sessionId
    ) {
      return null;
    }
    return {
      projectPath: parsed.projectPath,
      source: parsed.source,
      sessionId: parsed.sessionId,
    };
  } catch {
    return null;
  }
}

export function storeSelection(selection: RememberedSelection | null): void {
  try {
    if (selection === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    /* storage disabled */
  }
}
