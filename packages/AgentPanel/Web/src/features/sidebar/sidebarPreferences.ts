import type { AgentSidebarMode } from "@/features/sidebar/AgentSidebar";

export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;

export interface SidebarPreferences {
  open: boolean;
  width: number;
  /**
   * Which of the sidebar's views is selected.
   *
   * Kept for the same reason its width is: it is a fact about how this reader has arranged the
   * panel, not about the session they happened to be looking at. Someone working on the canvas
   * reloads the page many times a day, and coming back to Sessions every time means re-choosing
   * the arrangement before the reload has told them anything.
   */
  mode: AgentSidebarMode;
}

const SIDEBAR_MODES: readonly AgentSidebarMode[] = ["sessions", "bots", "canvas"];

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  open: true,
  width: 264,
  mode: "sessions",
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
      mode: SIDEBAR_MODES.includes(parsed.mode as AgentSidebarMode)
        ? (parsed.mode as AgentSidebarMode)
        : DEFAULT_SIDEBAR_PREFERENCES.mode,
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
      mode: preferences.mode,
    }));
  } catch {
    // The panel remains usable with in-memory state when WebKit storage is disabled.
  }
}
