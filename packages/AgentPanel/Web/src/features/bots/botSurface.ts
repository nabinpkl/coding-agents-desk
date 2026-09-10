// Which colour each Bot's card wears on the canvas.
//
// The canvas is a strip of cards that all look the same, and the thing a reader is doing on it is
// finding one Bot among six. Name and avatar answer that after you read them; a surface colour
// answers it before you do, which is the whole job here.
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
  const ranked = [...bots].sort((a, b) =>
    a.createdAt - b.createdAt || (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
  const hues = new Map<string, number>();
  ranked.forEach((bot, index) => {
    hues.set(bot.botId, (BOT_HUE_OFFSET + index * BOT_HUE_STEP) % 360);
  });
  return hues;
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
