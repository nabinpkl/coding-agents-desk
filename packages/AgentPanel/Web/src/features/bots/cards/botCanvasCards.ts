// What every part of the canvas needs to agree on: the two widths and what a failure names.
//
// Small enough to have lived in `BotCanvas.tsx`, and moved out when the cards became files of
// their own: a card importing the surface it sits in for a number would be a cycle.

import type { BotSessionRef } from "@agentdesk/agent-feed-wire";

/** The `gap-3` between cards, in pixels, which a card stepping aside has to clear as well. */
export const STRIP_GAP = 12;

/**
 * The `gap-4` between one Bot's sessions, which is the same measurement one level down.
 *
 * Its own number rather than the strip's because the two gaps are set apart on purpose: sessions
 * sit further from each other than Bots do, since each carries a rail and two rails close together
 * read as one striped edge. Move the class and move this, or a dragged session steps aside by the
 * wrong amount and settles a few pixels off where it was drawn.
 */
export const SESSION_GAP = 16;

/**
 * How wide a session stands while it is closed, which is not a number anyone chose and not one
 * that is remembered.
 *
 * A closed session is a spine: a name, when it last said something, and the menu. It has no
 * contents to be a width FOR, so a width dragged onto it would be a width you set for a box you
 * could not see inside -- and it would then be the width you found the next time you opened it,
 * which is not what you meant. Wide enough for a truncated title beside its chevron, and narrow
 * enough that a Bot with several reads as a rank of spines rather than a stack of slabs.
 *
 * 293 rather than the 260 it was: 260, plus exactly what the session's avatar costs (a 24px mark
 * and the 8px gap after it), plus the pixel the Bot's rail took when it went from three to four.
 * Boxes here are border-box, so a wider leading edge comes straight out of the content beside it.
 * The spine has no slack in it -- at 260 with a mark in front, the meta line under the title lost
 * enough room that "03:39 AM" broke across two lines and the closed card grew a row instead of a
 * column. Add a fixed-width thing to this row, or widen one already on it, and this number moves.
 */
export const CLOSED_SESSION_WIDTH = 293;

/**
 * A failed Bot command, and which session it was about.
 *
 * The session is carried because the canvas holds several at once and the failure belongs to one of
 * them: a bare string was shown on every open card, which named none of them and repeated itself
 * once per session the reader had open.
 *
 * Null where the failure is not about one particular session. So is a failure about a session the
 * canvas is not showing, which an attach that did not happen always is -- the session never joined
 * the Bot, so no card exists to carry it. Those go to the canvas's own band, said once rather than
 * lost.
 */
export interface BotCommandError {
  /** `source:sessionId`, or null when no card can carry it. */
  session: string | null;
  message: string;
}

export function sessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}
