// What order the sidebar's Bot roster stands in, and which of its rows are worth drawing at all.
//
// Two lists, one question. The roster is read while looking at the canvas, so what it answers
// first is "which of these am I looking at": Bots with cards above Bots without, and inside a
// Bot, sessions with cards above sessions without. Before this, dimming and a crossed eye said
// which was which and did nothing about where they were, so a Bot taken off the canvas months ago
// sat between two the reader was working in and pushed them down the panel.
//
// Pure, and apart from the components, because both surfaces that draw this roster have to reach
// the same answer and because the interesting cases -- a Bot with no sessions, a Bot whose every
// session is off the canvas -- are cheaper to pin here than through a render.

import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";

/** How the panel names one session: the same key the canvas stores its detached set under. */
export function attachedSessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * Whether this session is the Bot's Father now.
 *
 * Beside the key because every menu that offers the Father asks it, on both surfaces: the menu
 * shows the other act, so the caller derives the flag from the Bot's record rather than the
 * menu owning the fact.
 */
export function isFatherSession(bot: BotView, session: BotSessionRef): boolean {
  return bot.fatherSession !== undefined && attachedSessionKey(bot.fatherSession) === attachedSessionKey(session);
}

/**
 * When a Bot was last doing anything: the newest event across its sessions, or its own creation.
 *
 * `createdAt` for a Bot with no sessions rather than zero, so a Bot made this morning and never
 * used does not sink under one that has been quiet since last month. Both are milliseconds from
 * the same clock (`Date.now` in the registry, the transcript's mtime in the catalog), so they
 * compare directly.
 */
function lastActiveAt(bot: BotView): number {
  return bot.sessions.reduce((newest, session) => Math.max(newest, session.lastEventAt), bot.createdAt);
}

/**
 * The roster with the Bots that have no card at the bottom, least recently active last.
 *
 * Both ways of having no card sink together, because the row only has one thing to say: a Bot on
 * a hidden machine is as absent from the strip as a detached one, and splitting them into three
 * bands would be a second ordering to learn for a distinction the two controls already carry.
 * The way back differs; where the row sits does not.
 *
 * Only the sunk group is sorted. The Bots WITH cards arrive in the canvas's own arrangement
 * (`orderedBots`, which the strip and this list share), so this list reads left to right the way
 * the strip does -- and resorting them by activity would throw that away and move a row out from
 * under the reader every time a session emitted an event. A Bot with no card has no place on the
 * strip to keep, which is what leaves activity as the only ordering it can offer.
 */
export function withOffCanvasLast(
  bots: readonly BotView[],
  offCanvas?: {
    detachedBotIds: ReadonlySet<string>;
    machineHiddenBotIds: ReadonlySet<string>;
  },
): readonly BotView[] {
  // No canvas in the picture is not the same as nothing being off one: the Bots tab lists these
  // same Bots with no strip to be on, and has nothing to sink.
  if (!offCanvas) return bots;
  const gone = (bot: BotView) =>
    offCanvas.detachedBotIds.has(bot.botId) || offCanvas.machineHiddenBotIds.has(bot.botId);
  return [
    ...bots.filter((bot) => !gone(bot)),
    ...bots.filter(gone).sort((a, b) => lastActiveAt(b) - lastActiveAt(a)),
  ];
}

/**
 * Above this many sessions with no card, a Bot folds them behind one row.
 *
 * Three is the count at which a tail stops reading as "and these two are off" and starts reading
 * as a second list. A Bot the reader has taken off the canvas entirely is the case that made this
 * necessary: every one of its sessions is off, so the roster was spending a screen of dimmed rows
 * on the Bot a reader had just said they were done with.
 */
export const SESSIONS_FOLDED_ABOVE = 3;

export interface RosterSessions {
  /** The sessions with a card, in the Bot's own durable order. */
  withCard: SessionSummary[];
  /** The ones without, in that same order. Drawn below the others, folded when there are many. */
  withoutCard: SessionSummary[];
  /** Whether those are folded behind a disclosure rather than listed. */
  folded: boolean;
}

/**
 * A Bot's sessions split into the ones on the canvas and the ones off it, in that order.
 *
 * The Bot's own order is kept INSIDE each group rather than resorted, because unlike a Bot's place
 * on the strip a session's place in its Bot survives being taken off: it is the durable
 * `sessionRefs` order a reader arranged by dragging cards, and it is where the session comes back
 * to. Sorting the sunk ones by activity would discard the one arrangement they still have.
 */
export function splitSessionsByCanvas(
  sessions: readonly SessionSummary[],
  hasNoCard: (session: SessionSummary) => boolean,
): RosterSessions {
  const withoutCard = sessions.filter(hasNoCard);
  return {
    withCard: sessions.filter((session) => !hasNoCard(session)),
    withoutCard,
    folded: withoutCard.length > SESSIONS_FOLDED_ABOVE,
  };
}
