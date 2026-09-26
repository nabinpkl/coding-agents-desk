// Which colour each terminal parent's card wears on the canvas, and which step of it each
// of its sessions wears inside that card.
//
// The same two questions the Bot canvas answers in `botSurface.ts`, and the arithmetic is shared
// on purpose: the golden-angle spacing, the offset off alert-red, and the six-slot ladder are
// measured properties of this UI's palette, not of Bots, so a second copy of the numbers is two
// chances for one to drift. What is NOT shared is the ranking, because the rosters differ in the
// one way that matters:
//
// - Bot hues rank creation order, which is append-only: a new Bot takes the next index and
//   nothing moves. Terminal parents rank PATH order, and the set churns -- sessions start and
//   stop all day. A rank shift repaints the hues after it, which is accepted for the same reason
//   Bots used to accept it on detach before slots were stored: the alternative is hashing ids
//   into buckets, and neighbours sharing a colour on purpose is worse than a repaint after churn.
// - Bot shades rank the durable curation order. Terminal children have no curation, so they rank
//   name order, which is the only order a tmux roster has.
//
// Nothing is stored and nothing is chosen, for the reason `botSurface.ts` gives: a colour nobody
// picked is not an arrangement, and it is not a record the sidecar owns either.

import type { CSSProperties } from "react";
import {
  BOT_HUE_OFFSET,
  BOT_HUE_STEP,
  BOT_SESSION_HUE_SPACING,
  BOT_SESSION_SHADES,
} from "@/features/bots/botSurface";

/** Enough of a terminal parent to colour its card: its key and the path it stands for. */
export interface TerminalParentIdentity {
  key: string;
  path: string;
}

/**
 * Every parent's hue, by key.
 *
 * Ranked by path, key tie-broken for stability, over the WHOLE roster rather than the cards on
 * screen -- the same argument `botCanvasHues` makes: hiding a parent must recolour nothing, and
 * ranking the visible subset would repaint the canvas every time one was hidden.
 */
export function terminalParentHues(
  parents: readonly TerminalParentIdentity[],
): ReadonlyMap<string, number> {
  const hues = new Map<string, number>();
  orderedParents(parents).forEach((parent, index) => {
    hues.set(parent.key, (BOT_HUE_OFFSET + index * BOT_HUE_STEP) % 360);
  });
  return hues;
}

/**
 * Every parent's rank in the path order `terminalParentHues` colours by, by key.
 *
 * The face a parent wears is drawn from the same rank its colour is, which is what keeps the two
 * agreeing without either knowing about the other -- the same contract `botCanvasRanks` keeps.
 * One ordering, two readers, so this shares the sort rather than repeating it.
 */
export function terminalParentRanks(
  parents: readonly TerminalParentIdentity[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  orderedParents(parents).forEach((parent, index) => {
    ranks.set(parent.key, index);
  });
  return ranks;
}

function orderedParents(parents: readonly TerminalParentIdentity[]): TerminalParentIdentity[] {
  return [...parents]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * Each of one parent's sessions, by child key, on a step of that parent's ladder.
 *
 * Ranked over the name-sorted keys rather than over the sessions: a session that has just exited
 * still holds its step until the listing drops it, so the survivors keep their colours across the
 * refresh that reports the exit.
 */
export function terminalChildSteps(children: readonly string[]): ReadonlyMap<string, number> {
  const steps = new Map<string, number>();
  [...children].sort().forEach((key, index) => {
    steps.set(key, index % BOT_SESSION_SHADES);
  });
  return steps;
}

/**
 * The hue a parent card hands to CSS, as the one custom property `.terminal-surface` reads.
 *
 * Only the hue crosses this boundary, for the reason `botSurfaceStyle` gives: lightness and
 * chroma stay in `styles.css` behind the `prefers-color-scheme` query. Separate property names
 * from the Bot's, because both canvases can be mounted in one panel and a terminal card must
 * never resolve against a `--bot-hue` inherited from a card around it.
 */
export function terminalParentStyle(hue: number | undefined): CSSProperties | undefined {
  if (hue === undefined) return undefined;
  return { "--terminal-hue": hue.toFixed(2) } as CSSProperties;
}

/**
 * What a session's card hands to CSS: its parent's hue, and its own step on that parent's ladder.
 *
 * Both or neither, for the reason `botSessionStyle` gives: a step with no hue would resolve
 * against whatever the card around it carries.
 */
export function terminalChildStyle(
  hue: number | undefined,
  step: number | undefined,
): CSSProperties | undefined {
  if (hue === undefined || step === undefined) return undefined;
  return {
    "--terminal-hue": hue.toFixed(2),
    "--terminal-session-step": String(step),
    "--terminal-session-hue": ((hue + step * BOT_SESSION_HUE_SPACING) % 360).toFixed(2),
  } as CSSProperties;
}
