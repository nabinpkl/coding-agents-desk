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
  return [...bots].sort((a, b) =>
    a.createdAt - b.createdAt || (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
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
 * The face a session wears, from its Bot's rank and its own step on that Bot's ladder.
 *
 * A session does NOT share its Bot's face: a Bot with five sessions wearing one face five times
 * teaches nothing, where five faces teach which session is which. The face sits just past the
 * Bot's own rank, one step per session, so siblings are consecutive ranks -- and consecutive ranks
 * differ in every part, while anything under forty apart cannot repeat a face at all. Both inputs
 * are stable across reloads and detaches, so the face is too.
 */
export function botSessionFaceRank(botRank: number, step: number): number {
  return botRank + 1 + step;
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
 * reason `botSessionShades` gives: the durable list is what ranks stably.
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
 * Each of one Bot's sessions, by `source:sessionId`, on a step of that Bot's shade ladder.
 *
 * The HUE is the Bot's and does not move -- a session is that Bot's session before it is any
 * particular one -- so what separates two of them is lightness, with a little chroma behind it.
 * Which way the ladder climbs is the theme's business and lives in `styles.css`; what crosses this
 * boundary is a step number, the same split `botSurfaceStyle` keeps for the same reason.
 *
 * Ranked over `sessionRefs`, the Bot's durable curation order, rather than over `sessions`. Three
 * things follow, and each is why:
 *
 * - **A session the catalog has forgotten still holds its rank.** Those resolve to
 *   `missingSessionRefs` rather than to a summary, and ranking the resolved list would hand a
 *   missing session's shade to whichever session came after it.
 * - **Taking a session off the canvas recolours nothing**, and neither does a Bot whose card is
 *   showing a subset. Same argument as `botCanvasHues`: rank the roster, not the view.
 * - **A new session recolours nothing**, because attaching appends.
 *
 * What DOES move every shade after it is detaching a session, which shifts the tail of
 * `sessionRefs` by one. Unlike the Bot delete that `botCanvasHues` can call hypothetical, this
 * route exists and is in every row's menu. It is accepted rather than solved: the alternative is
 * hashing the session id into six buckets, and six sessions land in six distinct buckets 1.5% of
 * the time, so the common case would be two cards the same colour on purpose instead of a repaint
 * after a detach.
 *
 * A Bot with ONE session is ranked like any other and takes step zero. What it does NOT take is
 * a rail, and that is the card's decision rather than this one's -- a rail down the only thing
 * inside a container is a line drawn between a group and itself. The shade stays, because a
 * session card should be visibly a card sitting ON its Bot rather than a patch of the Bot's own
 * body, and step zero is 0.094 of lightness away from the Bot's surface in dark.
 *
 * Step zero is the BOTTOM of the ladder rather than the Bot's own surface, which it used to be.
 * Pinning it there meant the ladder could only climb, and the ceiling is close: `styles.css`
 * records `--muted-foreground` running out at 0.335, so all six shades had to fit inside 0.100 of
 * lightness and sat 0.0202 dEok apart. Unpinned they span 0.155 and sit 0.0311 apart. What is lost
 * is that a Bot with ONE session used to paint that session exactly the colour of the card around
 * it; what replaces it is better, because a session card that is not the colour of its container
 * is a session card you can see the edges of.
 */
export function botSessionShades(
  refs: readonly BotSessionShadeIdentity[],
): ReadonlyMap<string, number> {
  const shades = new Map<string, number>();
  refs.forEach((ref, index) => {
    shades.set(`${ref.source}:${ref.sessionId}`, index % BOT_SESSION_SHADES);
  });
  return shades;
}

/**
 * How far apart two neighbouring sessions of one Bot sit on the colour wheel, in degrees.
 *
 * The whole circle divided by the number of slots, which is the widest six things can be spaced
 * and is deliberately NOT a narrow arc around the Bot's own hue. A narrow arc was tried and
 * measured first: at the chroma a card carries, rotating a nearly-grey colour leaves a nearly-grey
 * colour, and even a 110 degree arc moved a fill 0.0054 dEok. Sixty degrees between neighbours at
 * full separation moves it 0.0510, which is the widest separation anything on this canvas gets.
 *
 * So a Bot's sessions are not shades of the Bot. They are six different colours, and the first one
 * happens to land on the Bot's own hue because the count starts there. What says they belong to
 * one Bot is the RAIL, which does not take this and must not: it is the single channel answering
 * "whose card is this", and a grouping cue that varies inside the group is not one. Spending the
 * hue at this level is only affordable BECAUSE the rail exists -- before it, similarity between
 * the fills was the only thing holding a Bot together, and it had to be paid for in sameness.
 */
export const BOT_SESSION_HUE_SPACING = 360 / BOT_SESSION_SHADES;

/** The hue a session paints: its slot's share of the circle, started at its Bot's own hue. */
function sessionHue(hue: number, shade: number): number {
  return (hue + shade * BOT_SESSION_HUE_SPACING) % 360;
}

/**
 * What a session's card hands to CSS: its Bot's hue, and its own step on that Bot's ladder.
 *
 * Both or neither. A session whose Bot the roster has not ranked has no hue to be a shade OF, and
 * a step with no hue would resolve against whatever `--bot-hue` it inherited from the card around
 * it -- which is the Bot's, so every session on an unranked card would quietly take the colour of
 * the card beside it.
 */
export function botSessionStyle(
  hue: number | undefined,
  shade: number | undefined,
): CSSProperties | undefined {
  if (hue === undefined || shade === undefined) return undefined;
  return {
    "--bot-hue": hue.toFixed(2),
    "--bot-session-step": String(shade),
    "--bot-session-hue": sessionHue(hue, shade).toFixed(2),
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
const CONNECTOR_WORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

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
    chosen.length === 1
      ? [...chosen[0]!].slice(0, 2).join("")
      : chosen.map((word) => [...word][0]!).join("");
  return letters.toUpperCase() || "S";
}
