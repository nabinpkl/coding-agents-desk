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

/**
 * Not a layout bound, the same way the height ceiling is not one. A card is free to be wider than
 * the panel -- the canvas scrolls sideways -- so this is only high enough that a stored number this
 * large is certainly corrupt rather than chosen.
 */
export const MAX_CARD_WIDTH = 8000;

export const DEFAULT_CARD_WIDTH = 440;

/**
 * The canvas width below which the strip shows exactly one card at a time.
 *
 * Two cards at the narrowest a card is allowed to be. Under that there is no arrangement of cards
 * side by side left to make, so the canvas stops trying and gives each card the whole width, which
 * is what turns a phone into a swipe between Bots rather than a sideways crawl across one.
 */
export const CAROUSEL_CANVAS_WIDTH = MIN_CARD_WIDTH * 2;

/**
 * Low enough to be out of the way rather than an opinion about what is readable: a card can be
 * squashed until only its header shows, and the session inside gives up its space first. Not zero,
 * because the grip is the last thing in the card and the card clips its own overflow -- a card
 * shorter than its own header and grip would be one you could no longer grab to drag back.
 */
export const MIN_CARD_HEIGHT = 80;

/**
 * Not a layout bound. A card is free to be taller than the screen -- the canvas scrolls, and a Bot
 * with a long transcript is exactly the case for a card taller than the window -- so this is only
 * high enough that a stored number this large is certainly corrupt rather than chosen. A drag
 * cannot cross a screen in one gesture, so nothing reaches it by pulling.
 */
export const MAX_CARD_HEIGHT = 8000;
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
 * Holds a width inside the usable range, which the panel is no part of.
 *
 * Width used to stop at the width of the row a card sat in, which is what made a card wrap to the
 * next line when you grew it. There are no lines now: the cards are one strip that scrolls
 * sideways, so a card wider than the panel is a card you asked to see more of, the same argument
 * that freed the height. A narrow canvas is handled by `CAROUSEL_CANVAS_WIDTH` instead, and that
 * one is a display decision rather than a stored one -- a phone must not be able to write the
 * panel's width over the width you chose on a Mac.
 */
export function clampCardWidth(width: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : DEFAULT_CARD_WIDTH;
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, wanted));
}

/**
 * Holds a height inside the usable range, which the window is no part of.
 *
 * Height used to stop at a share of the viewport, on the reasoning that a card taller than the
 * screen buries the cards below it. That is true and it is not this code's call to make: the canvas
 * is a scroller, the cards below are a scroll away rather than lost, and the whole point of
 * dragging a card is to say how much of it you want to see at once. Width is still held to the row
 * it sits in, and that one IS structural -- a card wider than the row would leave the page sideways
 * with nothing to scroll it.
 */
export function clampCardHeight(height: number): number {
  const wanted = Number.isFinite(height) ? Math.round(height) : DEFAULT_CARD_HEIGHT;
  return Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, wanted));
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

const OPEN_SESSION_KEY = "agent-panel.bot-canvas.open-session";

/**
 * Which session the canvas had open, as `source:sessionId`, remembered across reloads.
 *
 * The same reason the sidebar's own selection is remembered: this panel is edited while it is being
 * read, so a reload happens many times an hour, and every one of them closed the card someone was
 * reading and left a canvas of collapsed rosters to click back through.
 *
 * Identity only, and deliberately unresolved. The key may name a session that has since ended or a
 * Bot that no longer holds it, in which case no card opens and the canvas is the one it would have
 * been anyway -- there is nothing to repair, so nothing checks. What is NOT stored is which Bots are
 * on the canvas, for the reason `detachedBotIds` gives: a canvas that comes back whole costs one
 * click to arrange again, where one that comes back missing a Bot hides it from a reader who has
 * forgotten they took it off.
 */
export function loadCanvasOpenKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(OPEN_SESSION_KEY);
    // Checked for the shape it is written in, so a hand-edited value cannot become a lookup for a
    // key no session could ever have.
    return typeof raw === "string" && raw.includes(":") ? raw : null;
  } catch {
    return null;
  }
}

export function storeCanvasOpenKey(key: string | null): void {
  try {
    if (key === null) localStorage.removeItem(OPEN_SESSION_KEY);
    else localStorage.setItem(OPEN_SESSION_KEY, key);
  } catch {
    // The canvas still opens and closes rows; it just forgets which one by the next visit.
  }
}
