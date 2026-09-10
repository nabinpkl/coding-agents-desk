// What the IDE remembers about how THIS reader arranged it.
//
// The test in AGENTS.md ("Panel state: what is remembered, and where") is whether a fact would
// cost real work to re-establish after a reload and is not something the sidecar already knows.
// Which files are open and which directories are expanded fail that test twice over: the sidecar
// owns them, and it shares them between readers on purpose. What is here is the rest.
//
// Deliberately absent: drafts. An unsaved edit is autosaved to the file within a second, so
// storing a second copy of it here would be a second source of truth for the one piece of state
// where a divergence loses a reader's words.

export interface WorkspaceIdePreferences {
  /** Which workspace this reader was last in, re-resolved against the roster on load. */
  workspaceId: string | null;
  /** The file each workspace was left on, so switching back does not land on nothing. */
  activePathByWorkspace: Record<string, string>;
  /** Which paths are shown rendered rather than as source. Editable kinds only. */
  previewPathsByWorkspace: Record<string, string[]>;
  section: "explorer" | "sourceControl";
  sidebarVisible: boolean;
  terminalVisible: boolean;
  /** Pane sizes as a fraction of the window, which is what survives a resize. */
  sidebarFraction: number;
  terminalFraction: number;
}

export const DEFAULT_WORKSPACE_IDE_PREFERENCES: WorkspaceIdePreferences = {
  workspaceId: null,
  activePathByWorkspace: {},
  previewPathsByWorkspace: {},
  section: "explorer",
  sidebarVisible: true,
  terminalVisible: false,
  sidebarFraction: 0.24,
  terminalFraction: 0.32,
};

const STORAGE_KEY = "agent-panel.workspace-ide.preferences";

export const SIDEBAR_FRACTION_RANGE = [0.14, 0.5] as const;
export const TERMINAL_FRACTION_RANGE = [0.15, 0.7] as const;

export function clampFraction(value: number, [low, high]: readonly [number, number]): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function stringListRecord(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.every((path) => typeof path === "string")) {
      result[key] = entry as string[];
    }
  }
  return result;
}

/**
 * Read the stored preferences, validating every field rather than casting.
 *
 * A hand-edited or stale shape falls back to the default per field. Casting would turn a bad value
 * into a lookup for something that cannot exist, which surfaces later as an empty pane nobody can
 * explain.
 */
export function loadWorkspaceIdePreferences(): WorkspaceIdePreferences {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_IDE_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WORKSPACE_IDE_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<WorkspaceIdePreferences>;
    return {
      workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
      activePathByWorkspace: stringRecord(parsed.activePathByWorkspace),
      previewPathsByWorkspace: stringListRecord(parsed.previewPathsByWorkspace),
      section: parsed.section === "sourceControl" ? "sourceControl" : "explorer",
      sidebarVisible: parsed.sidebarVisible !== false,
      terminalVisible: parsed.terminalVisible === true,
      sidebarFraction: clampFraction(
        typeof parsed.sidebarFraction === "number"
          ? parsed.sidebarFraction
          : DEFAULT_WORKSPACE_IDE_PREFERENCES.sidebarFraction,
        SIDEBAR_FRACTION_RANGE,
      ),
      terminalFraction: clampFraction(
        typeof parsed.terminalFraction === "number"
          ? parsed.terminalFraction
          : DEFAULT_WORKSPACE_IDE_PREFERENCES.terminalFraction,
        TERMINAL_FRACTION_RANGE,
      ),
    };
  } catch {
    // A private window and a container with storage disabled both throw here, and both should get
    // a working IDE rather than a blank one.
    return DEFAULT_WORKSPACE_IDE_PREFERENCES;
  }
}

export function storeWorkspaceIdePreferences(preferences: WorkspaceIdePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The reader still gets the choice for this session.
  }
}
