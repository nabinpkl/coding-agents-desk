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

/**
 * Sizes belong to sessions, not to the Bots holding them. A Bot card once had a width and a height
 * of its own; both became empty space beside and below its sessions the moment those carried their
 * own, so there is one map here rather than two.
 *
 * Unlike a roster of Bots this map is not bounded by anything -- a project here holds hundreds of
 * sessions -- so it is PRUNED ON WRITE to the sessions actually on the canvas. A session detached
 * from a Bot is not coming back the way a detached Bot is, and a store that only ever grew would
 * carry a size for every session ever opened.
 */
const SESSION_SIZES_KEY = "agent-panel.bot-canvas.session-sizes";

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Holds a width inside the usable range, which the panel is no part of.
 *
 * Width used to stop at the width of the row a card sat in, which is what made a card wrap to the
 * next line when you grew it. There are no lines now: the cards are one strip that scrolls
 * sideways, so a card wider than the panel is a card you asked to see more of, the same argument
 * that freed the height. A narrow canvas is no different: the strip scrolls there too, so a phone
 * crawls sideways across a card rather than having one pinned to its width.
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

function loadSizes(key: string): BotCardSizes {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
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

function storeSizes(key: string, sizes: BotCardSizes, keep?: Iterable<string>): void {
  try {
    const wanted = keep === undefined ? null : new Set(keep);
    const clamped: BotCardSizes = {};
    for (const [id, size] of Object.entries(sizes)) {
      if (wanted && !wanted.has(id)) continue;
      clamped[id] = { width: clampCardWidth(size.width), height: clampCardHeight(size.height) };
    }
    localStorage.setItem(key, JSON.stringify(clamped));
  } catch {
    // The canvas stays usable on its in-memory sizes when storage is disabled.
  }
}

export function loadSessionCardSizes(): BotCardSizes {
  return loadSizes(SESSION_SIZES_KEY);
}

/** `onCanvas` is every session key currently on the canvas; anything else is dropped. */
export function storeSessionCardSizes(sizes: BotCardSizes, onCanvas: Iterable<string>): void {
  storeSizes(SESSION_SIZES_KEY, sizes, onCanvas);
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

/**
 * The order the Bots stand in on the canvas, left to right, as a list of their ids.
 *
 * Remembered because it is arranged rather than derived: the roster arrives in whatever order the
 * sidecar resolved it, which is no order at all from the reader's side, and a strip you can put in
 * an order that forgets it the moment you reload is not an arrangement.
 *
 * Held as ids rather than as positions, because position is a consequence of order and the widths
 * beside it. Ids the canvas no longer knows are ignored on read rather than pruned on write, so a
 * Bot taken off the canvas and put back keeps the place it had.
 */
const ORDER_STORAGE_KEY = "agent-panel.bot-canvas.order";

export function loadBotCanvasOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function storeBotCanvasOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // The canvas stays usable on its in-memory order when storage is disabled.
  }
}

/**
 * The Bots in the order the canvas puts them: the arranged ones first, in that order, then anything
 * the arrangement has never seen.
 *
 * A Bot made since the last arrangement lands at the END rather than wherever its id happens to sort
 * -- it arrives on the right, where a new thing belongs, instead of appearing in the middle of a
 * strip you had arranged and displacing what you were reading.
 */
export function orderBotsForCanvas<T extends { botId: string }>(bots: T[], order: string[]): T[] {
  const byId = new Map(bots.map((bot) => [bot.botId, bot]));
  const arranged: T[] = [];
  for (const id of order) {
    const bot = byId.get(id);
    if (!bot) continue;
    byId.delete(id);
    arranged.push(bot);
  }
  return [...arranged, ...byId.values()];
}

/** The ids of `bots`, in the order they are standing in. What a reorder is applied to. */
export function botCanvasOrderOf<T extends { botId: string }>(bots: T[]): string[] {
  return bots.map((bot) => bot.botId);
}

/** `order` with the entry at `from` lifted out and put back at `to`. */
export function moveInOrder(order: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
