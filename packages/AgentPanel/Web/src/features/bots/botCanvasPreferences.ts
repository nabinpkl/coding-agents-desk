/**
 * How tall a Bot's card stands while it holds the open session, remembered across visits.
 *
 * The CARD is the resized box rather than the session inside it, and the difference is what makes
 * the number mean something: a card is what occupies a grid row, so its height is the thing that
 * decides how many Bots you can still see beside and below the one you are reading. Everything
 * inside it -- the roster rows, the open row's titlebar, then `SessionView` with its transcript,
 * bands and terminal -- takes its share of that box by flexing, so nothing in the session states a
 * height of its own and nothing has to be told the box changed.
 *
 * One value for the whole canvas, not one per Bot. Only one session is open at a time, so only one
 * card is ever sized; a per-Bot map would hold the same number under a dozen keys and still have
 * nothing to say about the Bot you open next.
 */
export const MIN_OPEN_CARD_HEIGHT = 360;

/**
 * A hard ceiling for the stored number, well past any screen this runs on. The ceiling that
 * actually bites is the viewport one below; this exists so a value from a 6K display cannot come
 * back on a laptop as an absurdity.
 */
export const MAX_OPEN_CARD_HEIGHT = 1600;

export const DEFAULT_OPEN_CARD_HEIGHT = 780;

const STORAGE_KEY = "agent-panel.bot-canvas.open-card-height";

/**
 * Holds a height inside the usable range, and inside the window when one is given.
 *
 * The viewport share is what the old fixed `min(75dvh, 640px)` was for: a card taller than the
 * screen makes the cards under it unreachable without first scrolling past a whole session. It is
 * passed in rather than read here so a drag can clamp against the window it started in, and so
 * this stays callable with no DOM at all.
 */
export function clampOpenCardHeight(height: number, viewportHeight?: number): number {
  if (!Number.isFinite(height)) return DEFAULT_OPEN_CARD_HEIGHT;
  const ceiling =
    viewportHeight !== undefined && Number.isFinite(viewportHeight)
      ? Math.min(MAX_OPEN_CARD_HEIGHT, Math.max(MIN_OPEN_CARD_HEIGHT, Math.round(viewportHeight * 0.85)))
      : MAX_OPEN_CARD_HEIGHT;
  return Math.min(ceiling, Math.max(MIN_OPEN_CARD_HEIGHT, Math.round(height)));
}

export function loadOpenCardHeight(): number {
  if (typeof window === "undefined") return DEFAULT_OPEN_CARD_HEIGHT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_OPEN_CARD_HEIGHT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_OPEN_CARD_HEIGHT || parsed > MAX_OPEN_CARD_HEIGHT) {
      return DEFAULT_OPEN_CARD_HEIGHT;
    }
    return Math.round(parsed);
  } catch {
    return DEFAULT_OPEN_CARD_HEIGHT;
  }
}

export function storeOpenCardHeight(height: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampOpenCardHeight(height)));
  } catch {
    // The canvas stays usable on the session's in-memory height when storage is disabled.
  }
}
