/**
 * How a floating window stands, remembered across visits: its size, and where its reader carried it.
 *
 * One recipe for every window that floats over the panel -- the Father home, an arena run's manager --
 * each with its own storage keys and its own size range, since a home over the Bot strip and a manager
 * over a run's lanes want different room. A reading storage cannot give back, or one that makes no
 * sense, costs nothing: the window opens at its default.
 */

export interface FloatingWindowPosition {
  x: number;
  y: number;
}

export interface FloatingWindowRange {
  min: number;
  max: number;
  default: number;
}

/** How much of a window stays on screen at the bottom, so a hand can always grab it back. */
const EDGE_KEEP = 80;
/** How much of a window stays on screen sideways, for the same reason. */
const SIDE_KEEP = 120;

/**
 * The topmost a window may sit, so a strip of it stays inside the viewport however short the
 * window gets. Asked of a resting place too: a window hangs below the switch that opens it, and a
 * viewport shorter than the switch plus that gap must still leave a strip of it on screen.
 */
export function clampFloatingTop(top: number, viewportHeight: number): number {
  return Math.min(Math.max(top, 0), Math.max(viewportHeight - EDGE_KEEP, 0));
}

/**
 * Holds a window where a hand can find it: at least a strip of it stays inside the viewport on
 * every side, so no drag and no viewport shrink can strand it off-screen with no way back.
 */
export function clampFloatingPosition(
  position: FloatingWindowPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): FloatingWindowPosition {
  return {
    x: Math.min(Math.max(position.x, SIDE_KEEP - size.width), Math.max(viewport.width - SIDE_KEEP, 0)),
    y: clampFloatingTop(position.y, viewport.height),
  };
}

export interface FloatingWindowPreferences {
  clampWidth(width: number): number;
  clampHeight(height: number): number;
  loadWidth(): number;
  loadHeight(): number;
  storeWidth(width: number): void;
  storeHeight(height: number): void;
  /** Null until the reader first carries the window: its resting place needs nothing stored. */
  loadPosition(): FloatingWindowPosition | null;
  storePosition(position: FloatingWindowPosition): void;
}

/** The size and place memory of one window, under `keyPrefix` + "-width" / "-height" / "-position". */
export function floatingWindowPreferences(
  keyPrefix: string,
  ranges: { width: FloatingWindowRange; height: FloatingWindowRange },
): FloatingWindowPreferences {
  const clamp = (range: FloatingWindowRange) => (value: number): number => {
    const wanted = Number.isFinite(value) ? Math.round(value) : range.default;
    return Math.min(range.max, Math.max(range.min, wanted));
  };
  const clampWidth = clamp(ranges.width);
  const clampHeight = clamp(ranges.height);
  const load = (key: string, range: FloatingWindowRange, within: (value: number) => number) => (): number => {
    if (typeof window === "undefined") return range.default;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return range.default;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? within(parsed) : range.default;
    } catch {
      return range.default;
    }
  };
  // The default is stored as nothing, so a reader who never drags keeps following the default.
  const store = (key: string, range: FloatingWindowRange, within: (value: number) => number) => (value: number): void => {
    try {
      const clamped = within(value);
      if (clamped === range.default) localStorage.removeItem(key);
      else localStorage.setItem(key, String(clamped));
    } catch {
      // The window still resizes; it just opens at its default next time.
    }
  };
  const positionKey = `${keyPrefix}-position`;
  return {
    clampWidth,
    clampHeight,
    loadWidth: load(`${keyPrefix}-width`, ranges.width, clampWidth),
    loadHeight: load(`${keyPrefix}-height`, ranges.height, clampHeight),
    storeWidth: store(`${keyPrefix}-width`, ranges.width, clampWidth),
    storeHeight: store(`${keyPrefix}-height`, ranges.height, clampHeight),
    loadPosition: () => {
      if (typeof window === "undefined") return null;
      try {
        const raw = localStorage.getItem(positionKey);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { x, y } = parsed as Partial<FloatingWindowPosition>;
        if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
        return { x, y };
      } catch {
        return null;
      }
    },
    storePosition: (position) => {
      try {
        localStorage.setItem(positionKey, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }));
      } catch {
        // The window still moves; it just opens at its resting place next time.
      }
    },
  };
}
