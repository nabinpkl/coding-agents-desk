// What the IDE remembers about how THIS reader arranged it.
//
// The test in AGENTS.md ("Panel state: what is remembered, and where") is whether a fact would
// cost real work to re-establish after a reload and is not something the sidecar already knows.
// Which files are open and which directories are expanded fail that test twice over: the sidecar
// owns them, and it shares them between readers on purpose. What is here is the rest.
//
// Drafts are not here, and the file they are in says why: they are private to one tab and their
// quota has to be its own, so they live in `sessionStorage` (`workspaceIdeDrafts.ts`). Keeping them
// beside these would mean one 4MB file quietly costing the reader everything else this module
// remembers.

/** Source or rendered. Stored per file, and only where the reader said something. */
export type FileView = "source" | "preview";

export interface WorkspaceIdePreferences {
  /** Which workspace this reader was last in, re-resolved against the roster on load. */
  workspaceId: string | null;
  /** The file each workspace was left on, so switching back does not land on nothing. */
  activePathByWorkspace: Record<string, string>;
  /**
   * The files this reader has chosen a view for, against the default their kind would get.
   *
   * A choice rather than a set of previewed paths, and that distinction is the whole point: the
   * default is not the same for every kind -- a markdown file opens rendered, a TypeScript file
   * opens as source -- so "in the list" cannot mean "previewed" without meaning the opposite for
   * half the files in it. Absence is "however this kind opens", which is also what makes a later
   * change to a default reach files nobody has touched.
   */
  fileViewByWorkspace: Record<string, Record<string, FileView>>;
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
  fileViewByWorkspace: {},
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Workspace id -> path -> view, dropping anything that is not exactly that. */
function fileViewRecord(value: unknown): Record<string, Record<string, FileView>> {
  if (!isObject(value)) return {};
  const result: Record<string, Record<string, FileView>> = {};
  for (const [workspaceId, views] of Object.entries(value)) {
    if (!isObject(views)) continue;
    const kept: Record<string, FileView> = {};
    for (const [path, view] of Object.entries(views)) {
      if (view === "source" || view === "preview") kept[path] = view;
    }
    result[workspaceId] = kept;
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
      fileViewByWorkspace: fileViewRecord(parsed.fileViewByWorkspace),
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
