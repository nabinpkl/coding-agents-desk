export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;

export interface SidebarPreferences {
  open: boolean;
  width: number;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  open: true,
  width: 264,
};

const STORAGE_KEY = "agent-panel.sidebar.preferences";

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_PREFERENCES.width;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function loadSidebarPreferences(): SidebarPreferences {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SIDEBAR_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<SidebarPreferences>;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : DEFAULT_SIDEBAR_PREFERENCES.open,
      width:
        typeof parsed.width === "number" &&
        Number.isFinite(parsed.width) &&
        parsed.width >= MIN_SIDEBAR_WIDTH &&
        parsed.width <= MAX_SIDEBAR_WIDTH
          ? Math.round(parsed.width)
          : DEFAULT_SIDEBAR_PREFERENCES.width,
    };
  } catch {
    return DEFAULT_SIDEBAR_PREFERENCES;
  }
}

export function storeSidebarPreferences(preferences: SidebarPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      open: preferences.open,
      width: clampSidebarWidth(preferences.width),
    }));
  } catch {
    // The panel remains usable with in-memory state when WebKit storage is disabled.
  }
}
