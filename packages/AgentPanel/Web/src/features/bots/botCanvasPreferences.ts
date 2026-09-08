/**
 * How big each Bot's card stands on the canvas, remembered across visits.
 *
 * The sized box is the CARD, and the difference from sizing the session inside it is what makes the
 * numbers mean something: a card is what occupies space on the canvas, so its size is what decides
 * how many other Bots stay visible beside and below the one you are reading. Everything inside it --
 * the roster rows, the open row's titlebar, then `SessionView` with its transcript, bands and
 * terminal -- takes its share by flexing, so nothing in the session states a size of its own and
 * nothing has to be told the box changed.
 *
 * Per Bot rather than one size for the canvas, because that is what a tiled surface is: cards are
 * laid out by flowing at the widths they were given rather than by a track template, so a Bot you
 * watch all day can be wide and the rest can stay narrow beside it.
 *
 * HEIGHT only takes effect while the card holds the open session. Closed, a card is as tall as its
 * own roster and a remembered height would be empty space; the number waits for the next time that
 * Bot is opened.
 */
export const MIN_CARD_WIDTH = 320;
export const MAX_CARD_WIDTH = 1400;
export const DEFAULT_CARD_WIDTH = 440;

export const MIN_CARD_HEIGHT = 360;
export const MAX_CARD_HEIGHT = 1600;
export const DEFAULT_CARD_HEIGHT = 780;

export interface BotCardSize {
  width: number;
  height: number;
}

export type BotCardSizes = Record<string, BotCardSize>;

export const DEFAULT_CARD_SIZE: BotCardSize = {
  width: DEFAULT_CARD_WIDTH,
  height: DEFAULT_CARD_HEIGHT,
};

const STORAGE_KEY = "agent-panel.bot-canvas.card-sizes";

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Holds a width inside the usable range, and inside the canvas when one has been measured.
 *
 * The canvas bound is what makes this layout survive a narrow panel with no breakpoint to do it:
 * a card can never be wider than the row it sits in, so a phone, or a Mac with the sidebar dragged
 * out, gets one card per row without anything having to ask how wide the window is. It wins over
 * the floor as well -- below 320px of canvas there is no width that is both legible and inside the
 * page, and being inside the page matters more.
 */
export function clampCardWidth(width: number, canvasWidth?: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : DEFAULT_CARD_WIDTH;
  const ceiling =
    canvasWidth !== undefined && Number.isFinite(canvasWidth) && canvasWidth > 0
      ? Math.min(MAX_CARD_WIDTH, Math.round(canvasWidth))
      : MAX_CARD_WIDTH;
  return Math.min(ceiling, Math.max(MIN_CARD_WIDTH, wanted));
}

/**
 * Holds a height inside the usable range, and inside the window when one is given.
 *
 * The viewport share is what the old fixed `min(75dvh, 640px)` was for: a card taller than the
 * screen makes the cards under it unreachable without first scrolling past a whole session. It is
 * passed in rather than read here so a drag can clamp against the window it started in, and so this
 * stays callable with no DOM at all.
 */
export function clampCardHeight(height: number, viewportHeight?: number): number {
  const wanted = Number.isFinite(height) ? Math.round(height) : DEFAULT_CARD_HEIGHT;
  const ceiling =
    viewportHeight !== undefined && Number.isFinite(viewportHeight)
      ? Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(viewportHeight * 0.85)))
      : MAX_CARD_HEIGHT;
  return Math.min(ceiling, Math.max(MIN_CARD_HEIGHT, wanted));
}

export function loadBotCardSizes(): BotCardSizes {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const sizes: BotCardSizes = {};
    for (const [botId, size] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof size !== "object" || size === null) continue;
      const { width, height } = size as Partial<BotCardSize>;
      // Each dimension is judged on its own, so one unreadable number does not throw away the other.
      sizes[botId] = {
        width: inRange(width, MIN_CARD_WIDTH, MAX_CARD_WIDTH) ? Math.round(width) : DEFAULT_CARD_WIDTH,
        height: inRange(height, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT) ? Math.round(height) : DEFAULT_CARD_HEIGHT,
      };
    }
    return sizes;
  } catch {
    return {};
  }
}

export function storeBotCardSizes(sizes: BotCardSizes): void {
  try {
    const clamped: BotCardSizes = {};
    for (const [botId, size] of Object.entries(sizes)) {
      clamped[botId] = {
        width: clampCardWidth(size.width),
        height: clampCardHeight(size.height),
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // The canvas stays usable on its in-memory sizes when storage is disabled.
  }
}
