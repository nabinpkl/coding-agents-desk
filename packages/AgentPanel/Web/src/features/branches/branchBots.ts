// Which Bots and sessions the Branches tab shows: those marked for it on the Bot's record
// (`canvases.branches` in `bots.json`). The Feed canvas shows every Bot, marked or not.

import type { BotView } from "@agentdesk/agent-feed-wire";

/** Which canvas a shell draws: the Feed's, every Bot, or the Branches tab's. */
export type PanelCanvas = "bots" | "branches";

/**
 * The Bots on the Branches canvas, each with only the sessions listed for it there.
 *
 * Narrowed where the roster is made rather than on the canvas, so the sidebar beside it lists the
 * same rows the cards do. Only what is drawn is narrowed: `sessionRefs` stays whole, because the
 * commands a card sends (an order, a detach) are about the Bot's full list.
 */
export function botsOnBranches(bots: readonly BotView[]): BotView[] {
  return bots.flatMap((bot) => {
    const membership = bot.canvases?.branches;
    if (!membership) return [];
    const shown = new Set(membership.sessionRefs.map((ref) => `${ref.source}:${ref.sessionId}`));
    return [
      {
        ...bot,
        sessions: bot.sessions.filter((session) => shown.has(`${session.source}:${session.sessionId}`)),
        missingSessionRefs: bot.missingSessionRefs.filter((ref) => shown.has(`${ref.source}:${ref.sessionId}`)),
      },
    ];
  });
}
