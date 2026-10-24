// Which colour each Bot's card wears on the canvas, and which shade of it each of its sessions
// wears inside that card.
//
// The canvas is a strip of cards that all look the same, and the thing a reader is doing on it is
// finding one Bot among six. Name and avatar answer that after you read them; a surface colour
// answers it before you do, which is the whole job here. The same question is asked again one
// level down -- a Bot's sessions stand side by side and are the same shape as each other -- and it
// gets the same answer at a smaller scale: the hue says whose session it is, and a step along that
// hue says which one.
//
// Nothing is stored and nothing is chosen. A colour is DERIVED from the roster, for the reason
// `AGENTS.md` gives under "Panel state": storage is for a fact about how this reader arranged the
// panel, and a colour nobody picked is not an arrangement. It is also not a record the sidecar
// owns, so it is not a wire field either. If a reader ever wants to choose one, a preference layered
// over this default is a small change; a wire field added now would be a schema, a command and a
// mutation path bought before anyone asked.

import type { CSSProperties } from "react";

/**
 * Enough of a Bot to colour its card. Deliberately not `BotView`: the derivation reads two fields,
 * and saying so lets the tests build a roster without inventing sessions and metadata for it.
 */
export interface BotColourIdentity {
  botId: string;
  createdAt: number;
}

/**
 * The angle between one Bot's hue and the next, in degrees.
 *
 * The golden angle, which is what makes this work at every roster size rather than at one chosen
 * one: consecutive indices land far apart, and so do indices two and three apart, so the first ten
 * Bots are well separated without a palette having to be written down and without the spacing
 * changing when an eleventh arrives.
 *
 * The alternative, and the reason this is not it: hashing the id straight to a hue is a pure
 * function of the Bot alone, which is more appealing, and it was MEASURED against the six Bots
 * actually on this canvas. Two of them collided exactly -- one hue, two cards -- and two more
 * landed a degree apart, leaving three distinguishable colours out of six. That is the birthday
 * problem doing what it does with six items on a circle, not a bad hash; quantising to buckets only
 * moves it (six Bots into twelve buckets are all distinct 22% of the time). Spacing by rank is what
 * makes distinctness a property of the arithmetic instead of a hope.
 */
export const BOT_HUE_STEP = 137.508;

/**
 * Where the first Bot's hue starts.
 *
 * Arbitrary in every way except one: it decides which Bot is red, and starting at 0 puts the oldest
 * Bot on a hue that reads as an alert next to a UI whose only other colour is `--destructive`.
 */
export const BOT_HUE_OFFSET = 24;

/**
 * The roster in creation order, id tie-broken for stability.
 *
 * The one ordering both the hues and the ranks below are read from, so the two cannot disagree
 * about which Bot stands where.
 */
function orderedRoster(bots: readonly BotColourIdentity[]): BotColourIdentity[] {
  return [...bots].sort((a, b) => a.createdAt - b.createdAt || (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
}

/**
 * Every Bot's hue, by id.
 *
 * Ordered by creation, so a Bot's colour is fixed for as long as it exists. Two properties come out
 * of that, and both are the point:
 *
 * - **Taking a Bot off the canvas recolours nothing.** Call this with the whole roster rather than
 *   with the cards on screen and the ranks do not move, so hiding a Bot leaves the rest as they
 *   were. Ranking the visible subset instead would repaint the canvas every time one was detached.
 * - **A new Bot recolours nothing.** It is created last, so it takes the next index and everything
 *   before it keeps the index it had.
 *
 * What would break it is deleting a Bot, which shifts every rank after it. The sidecar has no route
 * that does that -- `botRoutes.ts` creates, attaches and detaches sessions, and nothing removes a
 * Bot -- so the roster is append-only by construction rather than by promise. If a delete is ever
 * added, this is what it costs, and the fix is to rank on something the deleted Bot cannot vacate.
 *
 * The tie-break on id matters more than it looks: two Bots created in the same millisecond would
 * otherwise be ordered by whatever order the sidecar happened to serialise them in, which is not
 * stable across snapshots, and their two colours would swap under the reader.
 */
export function botCanvasHues(bots: readonly BotColourIdentity[]): ReadonlyMap<string, number> {
  const hues = new Map<string, number>();
  orderedRoster(bots).forEach((bot, index) => {
    hues.set(bot.botId, (BOT_HUE_OFFSET + index * BOT_HUE_STEP) % 360);
  });
  return hues;
}

/**
 * Every Bot's rank in the creation order `botCanvasHues` colours by, by id.
 *
 * The face a Bot wears is drawn from the same rank its colour is, which is what keeps the two
 * agreeing without either knowing about the other: a Bot keeps its face for exactly as long as it
 * keeps its hue. One ordering, two readers, so this shares the sort rather than repeating it.
 */
export function botCanvasRanks(bots: readonly BotColourIdentity[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  orderedRoster(bots).forEach((bot, index) => {
    ranks.set(bot.botId, index);
  });
  return ranks;
}

/**
 * Where session face inputs start.
 *
 * Bots number from zero, so sessions number from here. Every input under 500 reaches its own
 * head-and-eyes pair, so the two never share a face while Bots number under 256 and every
 * session input stays under 500 -- forty Bots of six sessions each, hundreds past this roster.
 */
export const BOT_SESSION_FACE_BASE = 256;

/**
 * The face a session wears, from its Bot's rank and its own stored slot.
 *
 * A session does NOT share its Bot's face: a Bot with five sessions wearing one face five times
 * teaches nothing, where five faces teach which session is which. The slot is unique within a
 * Bot, so siblings never share an input; the base keeps every session's input clear of every
 * Bot's. Both halves are stable across reloads, detaches and reorders, so the face is too.
 */
export function botSessionFaceRank(botRank: number, slot: number): number {
  return BOT_SESSION_FACE_BASE + botRank * BOT_SESSION_SHADES + slot;
}

/**
 * The hue a card hands to CSS, as the one custom property `.bot-surface` reads.
 *
 * Only the hue crosses this boundary. Lightness and chroma stay in `styles.css` behind the
 * `prefers-color-scheme` query, which is what makes the palette theme-aware without this module
 * knowing which theme is showing -- and it is why the colours are stated in oklch rather than as
 * hex: holding lightness and chroma fixed while only the hue turns is what keeps every Bot's card
 * at the same contrast against the text on it. Measured over sixteen hues in both themes:
 * `--foreground` never drops below 19:1 in light or 15.9:1 in dark, and `--muted-foreground`, the
 * one with room to lose, holds 4.55:1 in light against 4.73:1 on the untinted card, and 6.40:1 in
 * dark against 6.91:1. AA wants 4.5.
 *
 * A Bot with no hue gets no properties rather than a default one, so an unranked card renders as
 * the plain `--card` it was before instead of as whichever colour hue zero happens to be.
 */
export function botSurfaceStyle(hue: number | undefined): CSSProperties | undefined {
  if (hue === undefined) return undefined;
  return { "--bot-hue": hue.toFixed(2) } as CSSProperties;
}

/**
 * Enough of one of a Bot's sessions to shade it. The reference rather than the summary, for the
 * reason `botSessionSlots` gives: the stored slot is what ranks stably.
 */
export interface BotSessionShadeIdentity {
  source: string;
  sessionId: string;
}

/**
 * How many shades of its Bot's colour the ladder holds before it repeats.
 *
 * Six is what the palette can carry, not a preference. The ladder is bounded at both ends by the
 * contrast floor -- see `styles.css` for the measured steps -- and a seventh drops
 * `--muted-foreground` under AA in dark. Past the sixth it CYCLES rather than clamping: cycling
 * costs a collision between sessions six apart, which in a strip of side-by-side cards is far
 * enough away to be a different part of the screen, while clamping would give every session after
 * the sixth the same shade as its neighbour, which is the one thing this exists to prevent.
 */
export const BOT_SESSION_SHADES = 6;

/**
 * Each of one Bot's sessions, by `source:sessionId`, on its stored slot.
 *
 * The HUE is the Bot's and does not move -- a session is that Bot's session before it is any
 * particular one -- so what separates two of them is lightness, with a little chroma behind it.
 * Which way the ladder climbs is the theme's business and lives in `styles.css`; what crosses this
 * boundary is a slot number, the same split `botSurfaceStyle` keeps for the same reason. The shade
 * a slot paints is the slot mod the ladder; the face takes the whole slot, so siblings stay
 * distinct past the sixth instead of cycling onto each other's faces with their shades.
 *
 * Ranked from the Bot's stored `sessionSlots`, never from list position. Three things follow, and
 * each is why:
 *
 * - **A reorder repaints nothing.** The order moves and every slot stays where it was, so the
 *   arrangement a reader just made is not answered with six new colours and six new faces.
 * - **A detach shifts no tail.** The entry stays in the map while the reference is gone, so the
 *   sessions after it keep their step -- and a reattach restores the slot it kept, which is the
 *   same session wearing the same shade and face it left with.
 * - **A session the catalog has forgotten still holds its slot.** Those resolve to
 *   `missingSessionRefs` rather than to a summary, and ranking the resolved list would hand a
 *   missing session's shade to whichever session came after it.
 *
 * A record that predates slots reads as its current `sessionRefs` order, which is the migration
 * the sidecar writes out on its next read. Everything else -- taking a session off the canvas,
 * a card showing a subset -- was already ranked over the roster rather than the view, and still is.
 *
 * A Bot with ONE session takes slot zero. What it does NOT take is a rail, and that is the card's
 * decision rather than this one's -- a rail down the only thing in a container is a line drawn
 * between a group and itself. The shade stays, because a session card should be visibly a card
 * sitting ON its Bot rather than a patch of the Bot's own body, and step zero is 0.094 of
 * lightness away from the Bot's surface in dark.
 *
 * Step zero is the BOTTOM of the ladder rather than the Bot's own surface, which it used to be.
 * Pinning it there meant the ladder could only climb, and the ceiling is close: `styles.css`
 * records `--muted-foreground` running out at 0.335, so all six shades had to fit inside 0.100 of
 * lightness and sat 0.0202 dEok apart. Unpinned they span 0.155 and sit 0.0311 apart. What is lost
 * is that a Bot with ONE session used to paint that session exactly the colour of the card around
 * it; what replaces it is better, because a session card that is not the colour of its container
 * is a session card you can see the edges of.
 */
export function botSessionSlots(
  refs: readonly BotSessionShadeIdentity[],
  stored?: Record<string, number>,
): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  refs.forEach((ref, index) => {
    const key = `${ref.source}:${ref.sessionId}`;
    slots.set(key, stored?.[key] ?? index);
  });
  return slots;
}

/**
 * The hues a session's card can paint, in the order a Bot's sessions walk them.
 *
 * A fixed set rather than any hue on the circle, because dark's session surfaces (lightness
 * 0.205 to 0.255 at chroma 0.090) are outside sRGB for most of the circle, and clipping both drains
 * and bends them: 40, 60 and 80 degrees all paint as an orange near 30 to 50, and 140 and 160 both
 * paint near 145. So two hues 20 or 30 degrees apart, or further apart inside that stretch, came
 * out as one muddy colour, and sessions of DIFFERENT Bots, each a sixth of the circle from its own
 * Bot, landed within a few degrees of each other on a canvas whose neighbours have nothing to do
 * with creation order. Measured 2026-10-17: two cards side by side at 281.5 and 286.6 degrees.
 *
 * These eight were searched for, against the sRGB a display paints after clipping, to make the
 * CLOSEST two as far apart as eight can be: 0.054 dEok on dark's view and fill surfaces and 0.048
 * on light's border, the surfaces where each theme carries its colour. Two cards now either share a
 * colour exactly or differ by at least that, where before any separation from zero upward was as
 * likely as any other. What this does NOT buy is a guarantee about two cards from different Bots
 * side by side: a colour is derived from the card itself and never from where it stands, so moving
 * a card recolours nothing, and any two such cards share a colour one time in eight.
 *
 * The ORDER is the walk, chosen so that consecutive entries are the furthest apart of any ordering
 * -- at least 0.117 dEok on dark's view surface, and 0.054 two steps apart -- because a Bot's
 * sessions attached one after another stand next to each other in slot order. The 60-degree steps
 * this replaces held 0.040 at worst and 0.077 at the median.
 *
 * Not every neighbour is in slot order: a fork stands beside its source with whatever number the
 * counter had reached. So the sidecar, which spends the slots, skips any number that would paint
 * like the cards a new session stands between, and has to know how many entries there are:
 * `BOT_SESSION_HUE_COUNT`, which this list's length is tested against.
 */
export const BOT_SESSION_HUES = [58, 154, 284, 98, 319, 191, 354, 228] as const;

/** Where a Bot's sessions start the walk: the entry nearest the Bot's own hue, around the circle. */
function walkStart(hue: number): number {
  let best = 0;
  let nearest = Infinity;
  BOT_SESSION_HUES.forEach((candidate, index) => {
    const apart = Math.abs(((((candidate - hue) % 360) + 540) % 360) - 180);
    if (apart < nearest) {
      nearest = apart;
      best = index;
    }
  });
  return best;
}

/**
 * The hue a session paints, from its Bot's hue and its stored slot.
 *
 * The first session takes the palette entry nearest its Bot's hue, so it still reads as that Bot's
 * colour beside the rail, and each slot after it takes the next entry of the walk. The WHOLE slot,
 * not the slot's step on the six-step ladder: the hue goes round all eight entries before it
 * repeats, where the ladder cycles at six. A Bot's slots grow with every session it has ever held,
 * so a Bot with history holds slots like 1, 13 and 19, which are one step on the ladder and were
 * one colour while the hue followed the step (measured on this canvas, 2026-10-17: three of one
 * Bot's seven cards). Counted round eight they are three different entries.
 *
 * The sessions are not shades of the Bot: they are different colours, and only the first is near
 * the Bot's own. What says they belong to one Bot is the RAIL, which does not take this and must
 * not: it is the single channel answering "whose card is this", and a grouping cue that varies
 * inside the group is not one. A narrow arc around the Bot's hue was measured before any of this
 * and moved a card 0.0054 dEok, because rotating a low-chroma colour barely moves it.
 */
export function botSessionHue(hue: number, slot: number): number {
  return BOT_SESSION_HUES[(walkStart(hue) + slot) % BOT_SESSION_HUES.length]!;
}

/**
 * What a session's card hands to CSS, from its Bot's hue and its stored slot: the Bot's hue, the
 * session's step on that Bot's ladder (the slot round six), and its own hue (the slot round eight,
 * `botSessionHue`).
 *
 * Both or neither. A session whose Bot the roster has not ranked has no hue to be a shade OF, and
 * a step with no hue would resolve against whatever `--bot-hue` it inherited from the card around
 * it -- which is the Bot's, so every session on an unranked card would quietly take the colour of
 * the card beside it.
 */
export function botSessionStyle(hue: number | undefined, slot: number | undefined): CSSProperties | undefined {
  if (hue === undefined || slot === undefined) return undefined;
  return {
    "--bot-hue": hue.toFixed(2),
    "--bot-session-step": String(slot % BOT_SESSION_SHADES),
    "--bot-session-hue": botSessionHue(hue, slot).toFixed(2),
  } as CSSProperties;
}

/**
 * Words that are in a title without naming anything in it, skipped when picking a session's
 * letters.
 *
 * Short because the cost of a wrong entry is silent: drop a word that was carrying the name and
 * the mark points at the wrong thing forever. These thirteen are the ones that actually turn up
 * in session titles here, and the rule that keeps the list honest is that removing a word must
 * never leave the title meaning something else.
 */
const CONNECTOR_WORDS = new Set(["a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);

/**
 * The one or two letters that stand for a session on its avatar.
 *
 * A session title is prose a person typed, so unlike a Bot's name it is often long, often a
 * sentence, and often shares its first word with the session beside it. The mark has one job --
 * telling two of one Bot's sessions apart at a glance -- so the letters are picked for that and
 * not for being a faithful abbreviation.
 *
 * Three decisions, each one measured against titles on this canvas:
 *
 * - **Connectors are skipped.** "CPU and RAM usage" gives CR, not CA. The first letter of "and"
 *   is a letter that every title with a conjunction in it would hand over.
 * - **One word gives TWO of its letters**, where two words give one each. "evals" as a bare E
 *   collides with every other session starting in e, and a roster of six single-word titles is
 *   the common case here, not the edge one.
 * - **Digits count as letters**, so "fork 2" does not silently become "F".
 *
 * Falls back to "S" only for a title with nothing alphanumeric in it at all, which the caller
 * cannot produce today -- the title it passes falls back to a session id -- but which is a
 * transparent circle rather than an empty one if it ever does.
 */
export function sessionInitials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const named = words.filter((word) => !CONNECTOR_WORDS.has(word.toLowerCase()));
  const chosen = (named.length > 0 ? named : words).slice(0, 2);
  const letters =
    chosen.length === 1 ? [...chosen[0]!].slice(0, 2).join("") : chosen.map((word) => [...word][0]!).join("");
  return letters.toUpperCase() || "S";
}
