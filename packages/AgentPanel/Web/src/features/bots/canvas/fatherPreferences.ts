/**
 * How the Father home stands, remembered across visits.
 *
 * Its own file because it is its own idea: the canvas preferences remember the strip -- card
 * sizes, open rows, scroll, hidden machines -- while these remember the drawer over it, open
 * or shut and at the size its reader left it. One file per idea is what keeps both readable.
 */

/**
 * Whether the Father home is open, remembered across reloads.
 *
 * Closed until a reader opens it, because it floats over the strip and an unreadable value
 * must cost nothing: anything but an explicit true means shut.
 */
const FATHER_OPEN_KEY = "agent-panel.bot-canvas.father-open";

export function loadFatherOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(FATHER_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeFatherOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(FATHER_OPEN_KEY, "true");
    else localStorage.removeItem(FATHER_OPEN_KEY);
  } catch {
    // The home still opens and closes; it just forgets which by the next visit.
  }
}

/**
 * How tall the Father home stands, in pixels.
 *
 * Its own range rather than the cards': a card may tower over the window because the canvas
 * scrolls, while this home floats over the strip -- taller than the column buries what it
 * covers, shorter than a session clips the transcript it exists to show. 480 is a transcript
 * with a composer under it rather than an opinion about what is readable.
 */
export const FATHER_MIN_HEIGHT = 160;
export const FATHER_MAX_HEIGHT = 640;
export const FATHER_DEFAULT_HEIGHT = 480;

const FATHER_HEIGHT_KEY = "agent-panel.bot-canvas.father-height";

export function clampFatherHeight(height: number): number {
  const wanted = Number.isFinite(height) ? Math.round(height) : FATHER_DEFAULT_HEIGHT;
  return Math.min(FATHER_MAX_HEIGHT, Math.max(FATHER_MIN_HEIGHT, wanted));
}

export function loadFatherHeight(): number {
  if (typeof window === "undefined") return FATHER_DEFAULT_HEIGHT;
  try {
    const raw = localStorage.getItem(FATHER_HEIGHT_KEY);
    if (raw === null) return FATHER_DEFAULT_HEIGHT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampFatherHeight(parsed) : FATHER_DEFAULT_HEIGHT;
  } catch {
    return FATHER_DEFAULT_HEIGHT;
  }
}

export function storeFatherHeight(height: number): void {
  try {
    const clamped = clampFatherHeight(height);
    if (clamped === FATHER_DEFAULT_HEIGHT) localStorage.removeItem(FATHER_HEIGHT_KEY);
    else localStorage.setItem(FATHER_HEIGHT_KEY, String(clamped));
  } catch {
    // The home still resizes; it just opens at the default height next time.
  }
}

/**
 * How wide the Father home stands, in pixels.
 *
 * Narrower than a session's spine and the composer beside it stops being a composer; wider
 * than the column and the drawer stops floating over the strip and becomes it. 880 is the
 * width it always drew at, so a reader who never drags keeps exactly what they had.
 */
export const FATHER_MIN_WIDTH = 480;
export const FATHER_MAX_WIDTH = 1200;
export const FATHER_DEFAULT_WIDTH = 880;

const FATHER_WIDTH_KEY = "agent-panel.bot-canvas.father-width";

export function clampFatherWidth(width: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : FATHER_DEFAULT_WIDTH;
  return Math.min(FATHER_MAX_WIDTH, Math.max(FATHER_MIN_WIDTH, wanted));
}

export function loadFatherWidth(): number {
  if (typeof window === "undefined") return FATHER_DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(FATHER_WIDTH_KEY);
    if (raw === null) return FATHER_DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampFatherWidth(parsed) : FATHER_DEFAULT_WIDTH;
  } catch {
    return FATHER_DEFAULT_WIDTH;
  }
}

export function storeFatherWidth(width: number): void {
  try {
    const clamped = clampFatherWidth(width);
    if (clamped === FATHER_DEFAULT_WIDTH) localStorage.removeItem(FATHER_WIDTH_KEY);
    else localStorage.setItem(FATHER_WIDTH_KEY, String(clamped));
  } catch {
    // The home still resizes; it just opens at the default width next time.
  }
}
