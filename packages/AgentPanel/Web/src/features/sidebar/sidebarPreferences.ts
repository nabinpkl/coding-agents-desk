import type { AgentSidebarMode } from "@/features/sidebar/AgentSidebar";
import type { CanvasSidebarView } from "@/features/sidebar/CanvasSidebarViews";

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
  /**
   * Whether Bots wear their generated faces instead of their initials.
   *
   * Here rather than beside the generator because that file answers what a face IS and this one
   * answers what the reader chose to see -- and because the canvas preferences module is at its
   * line cap. Off until chosen: the initials are what every reader knows, and a face nobody asked
   * for is a rename nobody made.
   */
  botFaces: boolean;
  /** Which of the Canvas tab's views is selected, kept for the reason `mode` is. */
  canvasView: CanvasSidebarView;
  /**
   * Whether the Canvas tab's Sessions view groups sessions under their projects, or lists every
   * session flat with the most recently changed first. Grouped until chosen otherwise, because
   * that is the list every reader already knows.
   */
  canvasSessionsGrouped: boolean;
}

const SIDEBAR_MODES: readonly AgentSidebarMode[] = ["sessions", "bots", "canvas", "messages"];

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  open: true,
  width: 264,
  mode: "sessions",
  botFaces: false,
  canvasView: "bots",
  canvasSessionsGrouped: true,
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
      botFaces: typeof parsed.botFaces === "boolean" ? parsed.botFaces : DEFAULT_SIDEBAR_PREFERENCES.botFaces,
      canvasView: parsed.canvasView === "sessions" ? "sessions" : "bots",
      canvasSessionsGrouped:
        typeof parsed.canvasSessionsGrouped === "boolean"
          ? parsed.canvasSessionsGrouped
          : DEFAULT_SIDEBAR_PREFERENCES.canvasSessionsGrouped,
    };
  } catch {
    return DEFAULT_SIDEBAR_PREFERENCES;
  }
}

export function storeSidebarPreferences(preferences: SidebarPreferences): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        open: preferences.open,
        width: clampSidebarWidth(preferences.width),
        mode: preferences.mode,
        botFaces: preferences.botFaces === true,
        canvasView: preferences.canvasView,
        canvasSessionsGrouped: preferences.canvasSessionsGrouped,
      }),
    );
  } catch {
    // The panel remains usable with in-memory state when WebKit storage is disabled.
  }
}
