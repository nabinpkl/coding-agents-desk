/**
 * What the reader has arranged on the terminal canvas, remembered across visits.
 *
 * Three sets, all identity only, following the Bot canvas's detached sets
 * (`botCanvasPreferences.ts`): hidden parents by `machine:path`, off-strip children and open
 * children by `machine:name`. tmux names are unique per server but meaningless across machines,
 * so the machine is part of every key -- and neither half may contain a colon on top of the
 * separator: machine keys are `[a-z0-9-]+` or empty by `sidecarBoard`'s own rule, and the sidecar
 * refuses a tmux name outside `[A-Za-z0-9_.-]`, so a stored key with no colon, or with one in the
 * wrong place, was hand-edited and is dropped.
 *
 * Zoom and room ride beside them under their OWN keys, never the Bot canvas's: both canvases run
 * `useCanvasZoom`, and one canvas's fit must never open the other one drawn small.
 *
 * Every read and write is wrapped in `try`/`catch`, because a private window and a container with
 * storage disabled both throw -- the house rule from `AGENTS.md`.
 */

import { CANVAS_ROOM_STEPS } from "@/features/bots/botCanvasPreferences";
import { MIN_CANVAS_ZOOM } from "@/features/bots/useCanvasZoom";
import { isTerminalChildKey } from "@/features/terminal/canvas/terminalGroups";

const HIDDEN_PARENTS_KEY = "agent-panel.terminal-canvas.hidden-parents";
const OFF_STRIP_CHILDREN_KEY = "agent-panel.terminal-canvas.off-strip-children";
const OPEN_CHILDREN_KEY = "agent-panel.terminal-canvas.open-children";

function loadKeySet(key: string, shaped: (value: string) => boolean): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Each entry judged on its own: the dangerous direction for this store is the one where a
    // bad value HIDES something, so an unreadable entry is dropped without costing the ones
    // beside it.
    return new Set(parsed.filter((value): value is string => typeof value === "string" && shaped(value)));
  } catch {
    return new Set();
  }
}

function storeKeySet(key: string, values: ReadonlySet<string>): void {
  try {
    if (values.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // The canvas still hides, restores, opens and closes; it just forgets which by next visit.
  }
}

/** A parent key is `machine:path`: anything non-empty, since the home machine's key starts `:`. */
function isParentKey(value: string): boolean {
  return value.length > 0;
}

/**
 * A child key is `machine:session` with an optional `:window` or `:window.pane` suffix, judged
 * by the same parse the canvas reads: the machine half may be empty -- that is the panel's own
 * sidecar -- because the separator is still there. Each stored entry judged on its own, since
 * the dangerous direction is a bad value hiding something.
 */
function isChildKey(value: string): boolean {
  return isTerminalChildKey(value);
}

export function loadHiddenTerminalParents(): ReadonlySet<string> {
  return loadKeySet(HIDDEN_PARENTS_KEY, isParentKey);
}

export function storeHiddenTerminalParents(keys: ReadonlySet<string>): void {
  storeKeySet(HIDDEN_PARENTS_KEY, keys);
}

export function loadOffStripTerminalChildren(): ReadonlySet<string> {
  return loadKeySet(OFF_STRIP_CHILDREN_KEY, isChildKey);
}

export function storeOffStripTerminalChildren(keys: ReadonlySet<string>): void {
  storeKeySet(OFF_STRIP_CHILDREN_KEY, keys);
}

export function loadOpenTerminalChildren(): ReadonlySet<string> {
  return loadKeySet(OPEN_CHILDREN_KEY, isChildKey);
}

export function storeOpenTerminalChildren(keys: ReadonlySet<string>): void {
  storeKeySet(OPEN_CHILDREN_KEY, keys);
}

const TERMINAL_ZOOM_MODE_KEY = "agent-panel.terminal-canvas.zoom-mode";
const TERMINAL_ZOOM_SCALE_KEY = "agent-panel.terminal-canvas.zoom-scale";

export function loadTerminalZoomMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(TERMINAL_ZOOM_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeTerminalZoomMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(TERMINAL_ZOOM_MODE_KEY, "on");
    else localStorage.removeItem(TERMINAL_ZOOM_MODE_KEY);
  } catch {
    // The canvas still zooms; it just opens at its own size next time.
  }
}

/** Checked rather than cast, so a stale value opens the canvas at fit instead of unwinding. */
export function loadTerminalZoomScale(): number {
  if (typeof window === "undefined") return MIN_CANVAS_ZOOM;
  try {
    const raw = localStorage.getItem(TERMINAL_ZOOM_SCALE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_CANVAS_ZOOM && parsed <= 1
      ? parsed
      : MIN_CANVAS_ZOOM;
  } catch {
    return MIN_CANVAS_ZOOM;
  }
}

export function storeTerminalZoomScale(scale: number): void {
  try {
    if (Number.isFinite(scale) && scale >= MIN_CANVAS_ZOOM && scale <= 1) {
      localStorage.setItem(TERMINAL_ZOOM_SCALE_KEY, String(scale));
    } else localStorage.removeItem(TERMINAL_ZOOM_SCALE_KEY);
  } catch {
    // The canvas still zooms; it just opens at fit next time.
  }
}

/** The `useCanvasZoom` store for this canvas: its own keys, never the Bot canvas's. */
export const TERMINAL_ZOOM_STORAGE = {
  loadMode: loadTerminalZoomMode,
  storeMode: storeTerminalZoomMode,
  loadScale: loadTerminalZoomScale,
  storeScale: storeTerminalZoomScale,
};

const TERMINAL_ROOM_KEY = "agent-panel.terminal-canvas.room";
/**
 * How much room the fitted canvas is given to be scrolled around in. The same steps the Bot
 * canvas offers -- the gutter is a property of the strip shape, not of whose cards stand on it --
 * validated against that same list so the two cannot drift apart.
 */
export function loadTerminalRoom(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(TERMINAL_ROOM_KEY);
    const parsed = raw === null ? 0 : Number(raw);
    return CANVAS_ROOM_STEPS.includes(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function storeTerminalRoom(size: number): void {
  try {
    if (size > 0 && CANVAS_ROOM_STEPS.includes(size)) localStorage.setItem(TERMINAL_ROOM_KEY, String(size));
    else localStorage.removeItem(TERMINAL_ROOM_KEY);
  } catch {
    // The canvas still draws; it just has no room around it next time.
  }
}

const TERMINAL_ACTIVE_ONLY_KEY = "agent-panel.terminal-canvas.active-only";

/**
 * Whether the canvas shows only parents with tmux standing in them. Off by default: an empty
 * parent is where a shell gets started, so hiding them is the reader's arrangement, not the
 * canvas's. Remembered like the other arrangement, under its own key.
 */
export function loadTerminalActiveOnly(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(TERMINAL_ACTIVE_ONLY_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeTerminalActiveOnly(on: boolean): void {
  try {
    if (on) localStorage.setItem(TERMINAL_ACTIVE_ONLY_KEY, "on");
    else localStorage.removeItem(TERMINAL_ACTIVE_ONLY_KEY);
  } catch {
    // The canvas still filters; it just opens unfiltered next time.
  }
}
