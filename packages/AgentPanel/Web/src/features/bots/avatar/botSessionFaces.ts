// The face a Bot's session wears in a list that is not its Bot's, so it reads as the same session
// it is on the canvas and in the roster.

import type { CSSProperties } from "react";
import type { Bin, BotView } from "@agentdesk/agent-feed-wire";
import { attachedSessionKey } from "@/features/bots/botRosterOrder";
import {
  botCanvasHues,
  botCanvasRanks,
  botSessionFaceRank,
  botSessionSlots,
  botSessionStyle,
} from "@/features/bots/botSurface";

/** What the canvas has taken off: the sets the strip subtracts by. */
export interface CanvasMembership {
  detachedBotIds: ReadonlySet<string>;
  /** The Bots with no card because their machine is hidden. */
  machineHiddenBotIds: ReadonlySet<string>;
  /** `source:sessionId` of each session taken off on its own. */
  detachedSessionKeys: ReadonlySet<string>;
}

/**
 * Whether a Bot's session has no card on the canvas right now: the session was taken off, its Bot
 * was, or its Bot's machine is hidden. One rule for every list that dims or unshades such a row.
 */
export function sessionOffCanvas(botId: string, sessionKey: string, canvas: CanvasMembership): boolean {
  return (
    canvas.detachedSessionKeys.has(sessionKey) ||
    canvas.detachedBotIds.has(botId) ||
    canvas.machineHiddenBotIds.has(botId)
  );
}

/** Everything `SessionAvatar` needs about one Bot's session, beyond its title and activity. */
export interface BotSessionFace {
  /**
   * The Bot's hue and this session's step, for an element around the face. Absent when the session
   * has no card, which leaves the face on its neutral disc the way the roster draws it.
   */
  style: CSSProperties | undefined;
  /** Which face it wears, absent when its Bot is unranked or it has no step yet. */
  rank: number | undefined;
  /** Whether its card on the canvas is unfolded, which the face says with open eyes. */
  open: boolean;
}

/** What the Canvas Sessions view's rows and the session modal's header draw a Bot's session with. */
export type SessionFaces = ReadonlyMap<string, BotSessionFace>;

/**
 * Every Bot session's face, by `source:sessionId`.
 *
 * Built from the whole roster, the way the roster and the canvas build theirs, so a session wears
 * the same colour, face and eyes here as on its card. A session two Bots hold takes its first one's.
 */
export function botSessionFaces(
  bots: readonly BotView[],
  canvas: CanvasMembership & { openSessionKeys: ReadonlySet<string> },
): SessionFaces {
  const hues = botCanvasHues(bots);
  const ranks = botCanvasRanks(bots);
  const faces = new Map<string, BotSessionFace>();
  for (const bot of bots) {
    const hue = hues.get(bot.botId);
    const botRank = ranks.get(bot.botId);
    const slots = botSessionSlots(bot.sessionRefs, bot.sessionSlots);
    for (const session of bot.sessions) {
      const key = attachedSessionKey(session);
      if (faces.has(key)) continue;
      const step = slots.get(key);
      faces.set(key, {
        style: sessionOffCanvas(bot.botId, key, canvas) ? undefined : botSessionStyle(hue, step),
        rank: botRank !== undefined && step !== undefined ? botSessionFaceRank(botRank, step) : undefined,
        open: canvas.openSessionKeys.has(key),
      });
    }
  }
  return faces;
}

/**
 * A Bot's session's face with its activity as the roster has it now, or undefined for a session no
 * Bot holds.
 *
 * For a surface that holds an older record of the session, as the session modal does from the
 * moment it opened: that record's activity would leave the live ring where it was.
 */
export function botSessionMarkNow(
  faces: SessionFaces,
  bots: readonly BotView[],
  sessionKey: string,
): { face: BotSessionFace; activity: Bin } | undefined {
  const face = faces.get(sessionKey);
  if (!face) return undefined;
  for (const bot of bots) {
    const session = bot.sessions.find((each) => attachedSessionKey(each) === sessionKey);
    if (session) return { face, activity: session.activity };
  }
  return undefined;
}
