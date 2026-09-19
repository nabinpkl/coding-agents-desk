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
 * What is NOT here, deliberately: sizes, order, and scroll. Tiles are fixed at 80x24 and never
 * claim, so a remembered size would be a number nothing reads; parents sort by path and children
 * by name, so an order would be an arrangement nothing offers; scroll is the strip's own business
 * in T3.
 *
 * Every read and write is wrapped in `try`/`catch`, because a private window and a container with
 * storage disabled both throw -- the house rule from `AGENTS.md`.
 */

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
 * A child key is `machine:session`: exactly one colon and a non-empty session half. The machine
 * half may be empty -- that is the panel's own sidecar -- because the separator is still there.
 * The sidecar's name rule keeps colons out of both halves, so a second colon means hand-edited.
 */
function isChildKey(value: string): boolean {
  const first = value.indexOf(":");
  if (first < 0 || first + 1 >= value.length) return false;
  return value.indexOf(":", first + 1) === -1;
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
