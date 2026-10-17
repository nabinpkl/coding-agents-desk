/**
 * How the Father home stands, remembered across visits.
 *
 * Its own file because it is its own idea: the canvas preferences remember the strip -- card
 * sizes, open rows, scroll, hidden machines -- while these remember the drawer over it, open
 * or shut and at the size and place its reader left it. One file per idea is what keeps both
 * readable.
 */

import { floatingWindowPreferences } from "@/features/floating-window/floatingWindowPreferences";

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
 * How big the Father home stands, and where its reader carried it, in its own range rather than
 * the cards': a card may tower over the window because the canvas scrolls, while this home floats
 * over the strip -- taller than the column buries what it covers, shorter than a session clips the
 * transcript it exists to show. 480 tall is a transcript with a composer under it; 880 wide is the
 * width it always drew at, so a reader who never drags keeps exactly what they had.
 */
export const FATHER_WINDOW = floatingWindowPreferences("agent-panel.bot-canvas.father", {
  width: { min: 480, max: 1200, default: 880 },
  height: { min: 160, max: 640, default: 480 },
});
