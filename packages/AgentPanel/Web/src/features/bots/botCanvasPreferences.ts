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

/**
 * 446 rather than the 440 it was, and the six pixels came from the Bot card around it rather than
 * from anywhere new. A Bot is exactly as big as the sessions standing in it, so when the roster's
 * trailing inset went from sixteen to ten (`BotCanvasCard`), the Bot card got six pixels narrower
 * and the transcript got nothing. Taking them here puts the Bot back at the size it was and spends
 * the trim on the thing a reader is actually looking at.
 *
 * It reaches a card that has never been dragged, which is the only card it can reach: a stored
 * width is the reader's own answer and nothing here may rewrite it. Move the roster's inset again
 * and this number moves with it, in the opposite direction and by the same amount.
 */
export const DEFAULT_CARD_WIDTH = 446;

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
/** 792 for the reason `DEFAULT_CARD_WIDTH` is 446, doubled: the trim took six off the top and six
 *  off the bottom where it took six off one side only. */
export const DEFAULT_CARD_HEIGHT = 792;

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

/**
 * The name is the singular it was when the canvas held one card open, kept deliberately: a reader
 * upgrading has the old bare-string value under it, and reusing the name overwrites that on the
 * first write instead of orphaning it beside the new one forever.
 */
const OPEN_SESSIONS_KEY = "agent-panel.bot-canvas.open-session";

/**
 * Which sessions the canvas has open, as `source:sessionId`, remembered across reloads.
 *
 * The same reason the sidebar's own selection is remembered: this panel is edited while it is being
 * read, so a reload happens many times an hour, and every one of them closed the cards someone was
 * reading and left a canvas of collapsed rosters to click back through. A set rather than one key
 * because a card is a whole session and reading two at once is the point of a canvas; what used to
 * argue for one at a time was a stream budget that was measured and found to be about thirty cards,
 * against a machine that holds six sessions.
 *
 * Identity only: a key is an address, and nothing here resolves it. What DOES resolve it is the app,
 * against a roster it has and that holds something -- a key no Bot holds a reference to any more is
 * dropped there (`AgentPanelApp.tsx`), because it opens nothing, is invisible for exactly that
 * reason, and would otherwise sit in the store for good. It is the emptiness that has to be ruled
 * out rather than the arrival: a snapshot lands before the Bots are in it, and that one is
 * indistinguishable from a reader with no Bots except that pruning against it costs a whole canvas. A key whose Bot still holds it but whose transcript
 * the sidecar cannot read this minute is kept, so a session that comes back comes back open.
 *
 * What is on the canvas at all is stored beside this, and the note on the detached sets below says
 * what changed to earn that.
 */
export function loadCanvasOpenKeys(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(OPEN_SESSIONS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Each entry checked for the shape it is written in, so a hand-edited value cannot become a
    // lookup for a key no session could ever have.
    return new Set(
      parsed.filter((key): key is string => typeof key === "string" && key.includes(":")),
    );
  } catch {
    return new Set();
  }
}

export function storeCanvasOpenKeys(keys: ReadonlySet<string>): void {
  try {
    if (keys.size === 0) localStorage.removeItem(OPEN_SESSIONS_KEY);
    else localStorage.setItem(OPEN_SESSIONS_KEY, JSON.stringify([...keys]));
  } catch {
    // The canvas still opens and closes rows; it just forgets which ones by the next visit.
  }
}

/**
 * How far the canvas is scrolled, in pixels, remembered across reloads.
 *
 * Pixels, and they mean something here because what they are an offset INTO is already pinned down
 * by what sits beside this: the strip is the arranged ORDER of the Bots, laid out at the WIDTHS
 * stored per session, so a number names the same place on the next visit rather than wherever the
 * stream happened to lay the cards out. A transcript is the case that fails that test -- rows are
 * estimated until measured, and the window they are drawn from moves -- so that one stores the
 * event at the top of the viewport instead (`transcriptScrollStore`).
 *
 * Both axes, because a card is as tall as its own roster and a tall one scrolls the canvas down as
 * well as along.
 *
 * CONTENT-space pixels rather than the scroller's own, because the canvas's zoom mode draws this
 * same strip at a smaller scale and an offset taken at one scale names a different card at
 * another. Divided by the scale on the way out and multiplied back on the way in; see
 * `useRememberedCanvasScroll`. Everything written before that mode existed was taken at scale 1,
 * which is what it still means, so there is nothing to migrate.
 *
 * Clamped by the browser on the way in: assigning past the end of a scroller lands at the end, so a
 * remembered offset for a canvas that has since lost half its cards degrades to its last card
 * rather than to nothing.
 */
const SCROLL_KEY = "agent-panel.bot-canvas.scroll";

export interface CanvasScroll {
  left: number;
  top: number;
}

/**
 * Whether the fitted canvas is given a gutter to be scrolled around in.
 *
 * Here rather than beside the zoom mode and scale in `useCanvasZoom`, which is where the rest of
 * that mode's storage lives, for two reasons that agree: this is an arrangement the reader made
 * rather than anything the gesture reads, and that file is at its line cap.
 */
const ROOM_KEY = "agent-panel.bot-canvas.room";

export function loadCanvasRoomMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ROOM_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeCanvasRoomMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(ROOM_KEY, "on");
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    // The canvas still draws; it just has no room around it next time.
  }
}

function offset(value: unknown): number {
  // Negative is a place, not a mistake. The zoom mode leaves room around the canvas to be scrolled
  // into, and an offset is measured from the canvas's own top-left, so a reader who parks the
  // canvas below or right of where it starts stores a number behind its start. The browser clamps
  // anything unreachable on the way back in, which is what makes accepting them safe.
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function loadCanvasScroll(): CanvasScroll {
  if (typeof window === "undefined") return { left: 0, top: 0 };
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    if (!raw) return { left: 0, top: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { left: 0, top: 0 };
    const { left, top } = parsed as Partial<CanvasScroll>;
    // Each axis judged on its own, so one unreadable number does not throw away the other.
    return { left: offset(left), top: offset(top) };
  } catch {
    return { left: 0, top: 0 };
  }
}

export function storeCanvasScroll(scroll: CanvasScroll): void {
  try {
    if (scroll.left === 0 && scroll.top === 0) localStorage.removeItem(SCROLL_KEY);
    else localStorage.setItem(SCROLL_KEY, JSON.stringify({
      left: Math.round(offset(scroll.left)),
      top: Math.round(offset(scroll.top)),
    }));
  } catch {
    // The canvas still scrolls; it just opens at the left edge next time.
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
export function botCanvasOrderOf<T extends { botId: string }>(bots: readonly T[]): string[] {
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

/**
 * What the reader has taken off the canvas: whole Bots by id, and single sessions as
 * `source:sessionId`.
 *
 * This reverses what the open-keys note above says, and the reversal is the point rather than an
 * oversight. Not storing it was right when the only sign that a Bot was off the canvas was the
 * canvas being one card shorter -- a set that came back would hide a Bot from a reader who had
 * forgotten taking it off, and rebuilding the canvas cost one click. The sidebar roster has since
 * become the answer to both halves: it lists every Bot and every session either way, dims the ones
 * that are off, and carries the toggle that puts them back. So the absence is stated on screen
 * rather than inferred from a gap, and the reader who has forgotten is told.
 *
 * What makes it worth storing rather than merely allowed is the cost of the other side. Taking
 * things off is how a busy canvas is made readable, and this panel is edited while it is read, so
 * a set that forgets is one the reader re-enters many times a day.
 *
 * Identity only, and unlike the open keys these are NOT pruned against the roster. The difference is
 * which way a stale entry fails. A stale open key is silent: it opens nothing and nobody can tell it
 * is there. A stale entry here hides something, and hiding is the thing the roster announces -- the
 * row is listed, dimmed, with the control that puts it back -- so it is visible rather than lost,
 * and a session its Bot takes back is one the reader can see is off the canvas. They grow only by an
 * explicit removal and shrink on restore, which is bound enough.
 */
const DETACHED_BOTS_KEY = "agent-panel.bot-canvas.off-canvas-bots";
const DETACHED_SESSIONS_KEY = "agent-panel.bot-canvas.off-canvas-sessions";

function loadDetached(key: string, shaped: (value: string) => boolean): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Each entry judged on its own: the dangerous direction for this store is the one where a bad
    // value HIDES something, so an unreadable entry is dropped without costing the ones beside it.
    return new Set(parsed.filter((value): value is string => typeof value === "string" && shaped(value)));
  } catch {
    return new Set();
  }
}

function storeDetached(key: string, values: ReadonlySet<string>): void {
  try {
    if (values.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // The canvas still hides and restores; it just forgets what by the next visit.
  }
}

export function loadDetachedBotIds(): ReadonlySet<string> {
  return loadDetached(DETACHED_BOTS_KEY, (id) => id.length > 0);
}

export function storeDetachedBotIds(ids: ReadonlySet<string>): void {
  storeDetached(DETACHED_BOTS_KEY, ids);
}

export function loadDetachedSessionKeys(): ReadonlySet<string> {
  return loadDetached(DETACHED_SESSIONS_KEY, (key) => key.includes(":"));
}

export function storeDetachedSessionKeys(keys: ReadonlySet<string>): void {
  storeDetached(DETACHED_SESSIONS_KEY, keys);
}

const HIDDEN_MACHINES_KEY = "agent-panel.bot-canvas.hidden-machines";

/**
 * Machines whose Bots the canvas is not showing, by the key `machineKey` gives.
 *
 * The canvas reads every declared machine at once, which is the point of it -- a Bot on a remote
 * peer standing beside one on this Mac -- and is also the reason a reader needs a way to say "not
 * that one right now". It passes the same test the detached sets pass (`AGENTS.md`, "Panel state"):
 * it is an arrangement nobody else knows, it costs real clicks to redo, and its absence is VISIBLE
 * because the machine's chip stays in the row saying how many cards it is holding back.
 *
 * Keys, not labels. A label is what a reader is shown and can change when a peer is renamed; the
 * key is the id the dev server routes by, so a stored entry keeps meaning the same machine.
 *
 * A key for a machine that is no longer declared is kept rather than pruned: a peer that is off
 * today is the same peer tomorrow, and forgetting that it was hidden would put its cards back on a
 * canvas the reader had tidied.
 */
export function loadHiddenMachines(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(HIDDEN_MACHINES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Checked for the shape it is written in. The empty string is this machine's own key, which is
    // a legitimate thing to hide, so length is not the test -- being a string is.
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    return new Set();
  }
}

export function storeHiddenMachines(keys: ReadonlySet<string>): void {
  try {
    if (keys.size === 0) localStorage.removeItem(HIDDEN_MACHINES_KEY);
    else localStorage.setItem(HIDDEN_MACHINES_KEY, JSON.stringify([...keys]));
  } catch {
    // The canvas still hides and shows machines; it just forgets which by the next visit.
  }
}
