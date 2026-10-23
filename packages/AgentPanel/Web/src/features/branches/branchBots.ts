// Which Bots and sessions the Branches tab shows: those marked for it on the Bot's record
// (`canvases.branches` in `bots.json`). The Feed canvas shows every Bot, marked or not, with every
// session but the ones marked exclusive to Branches (`exclusiveSessionRefs`).

import type { BotSessionRef, BotView, SetBotCanvasCommand } from "@agentdesk/agent-feed-wire";

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

/**
 * Every Bot as the Feed canvas shows it: each without the sessions exclusive to another canvas.
 *
 * Narrowed like `botsOnBranches`, and for its reason: `sessionRefs` stays whole for the commands.
 * A Bot whose every session is exclusive elsewhere still stands on the Feed, with none.
 */
export function botsOnFeed(bots: readonly BotView[]): BotView[] {
  return bots.map((bot) => {
    const hidden = exclusiveKeys(bot);
    if (hidden.size === 0) return bot;
    return {
      ...bot,
      sessions: bot.sessions.filter((session) => !hidden.has(`${session.source}:${session.sessionId}`)),
      missingSessionRefs: bot.missingSessionRefs.filter((ref) => !hidden.has(`${ref.source}:${ref.sessionId}`)),
    };
  });
}

/** The `source:sessionId` keys of every session these Bots keep off the Feed. */
export function feedHiddenSessionKeys(bots: readonly BotView[]): Set<string> {
  return new Set(bots.flatMap((bot) => [...exclusiveKeys(bot)]));
}

function exclusiveKeys(bot: BotView): Set<string> {
  return new Set(
    Object.values(bot.canvases ?? {}).flatMap((membership) =>
      (membership?.exclusiveSessionRefs ?? []).map((ref) => `${ref.source}:${ref.sessionId}`),
    ),
  );
}

/**
 * The canvas command that adds a session started on Branches to its Bot's Branches list, exclusive
 * to Branches, or null when the Bot is not on Branches or already lists it. A session begun there
 * is Branches work, and the Feed leaves it out. The list is replaced whole on the record, so it is
 * built from the one the Bot holds now.
 */
export function branchesWithSession(bot: BotView, ref: BotSessionRef): SetBotCanvasCommand | null {
  const membership = bot.canvases?.branches;
  if (!membership) return null;
  const listed = membership.sessionRefs;
  if (listed.some((each) => each.source === ref.source && each.sessionId === ref.sessionId)) return null;
  const plain = ({ source, sessionId }: BotSessionRef): BotSessionRef => ({ source, sessionId });
  // Replaced whole on the record, so the sessions already exclusive to Branches are named again.
  const only = membership.exclusiveSessionRefs ?? [];
  return {
    canvases: {
      branches: {
        sessionRefs: [...listed.map(plain), plain(ref)],
        exclusiveSessionRefs: [...only.map(plain), plain(ref)],
      },
    },
  };
}

/** The ⋮ item that moves a session between the two canvases, and what choosing it sends. */
export interface CanvasShareChoice {
  label: string;
  command: SetBotCanvasCommand;
}

/**
 * What the ⋮ on a session's card offers about the other canvas, seen from the one it is on.
 *
 * A session lives on one canvas by default: begun on the Feed it is not on Branches, begun on
 * Branches it is kept off the Feed. This is the one way to show it on both, and back.
 *
 * - On the Feed: "Show on Branches too" adds it to the Bot's Branches list (adding the Bot to
 *   Branches if it was not there), and "Show on Feed only" takes it off that list again.
 * - On Branches: "Show on Feed too" takes it off the Branches-only list, and "Keep on Branches
 *   only" puts it back on.
 *
 * Both lists are replaced whole on the record, so each is rebuilt from the one the Bot holds now.
 */
export function canvasShareChoice(bot: BotView, ref: BotSessionRef, canvas: PanelCanvas): CanvasShareChoice | null {
  const plain = ({ source, sessionId }: BotSessionRef): BotSessionRef => ({ source, sessionId });
  const same = (each: BotSessionRef) => each.source === ref.source && each.sessionId === ref.sessionId;
  const membership = bot.canvases?.branches;
  const listed = (membership?.sessionRefs ?? []).map(plain);
  const only = (membership?.exclusiveSessionRefs ?? []).map(plain);
  const branches = (sessionRefs: BotSessionRef[], exclusiveSessionRefs: BotSessionRef[]): SetBotCanvasCommand => ({
    canvases: { branches: { sessionRefs, ...(exclusiveSessionRefs.length === 0 ? {} : { exclusiveSessionRefs }) } },
  });
  const onBranches = listed.some(same);
  if (canvas === "bots") {
    return onBranches
      ? {
          label: "Show on Feed only",
          command: branches(
            listed.filter((each) => !same(each)),
            only.filter((each) => !same(each)),
          ),
        }
      : { label: "Show on Branches too", command: branches([...listed, plain(ref)], only) };
  }
  // A card on Branches is one its Bot lists there; anything else has no Branches record to change.
  if (!onBranches) return null;
  return only.some(same)
    ? {
        label: "Show on Feed too",
        command: branches(
          listed,
          only.filter((each) => !same(each)),
        ),
      }
    : { label: "Keep on Branches only", command: branches(listed, [...only, plain(ref)]) };
}

/**
 * The ⋮ item for a session's card on `canvas`, bound to the command that sends it: what the canvas
 * hands its cards, so a card needs to know neither which canvas it is on nor how a Bot is changed.
 */
export function canvasShareMenu(
  canvas: PanelCanvas,
  setBotCanvas: (botId: string, command: SetBotCanvasCommand, session: string | null) => Promise<boolean>,
) {
  return (bot: BotView, ref: BotSessionRef): { label: string; onSelect: () => void } | undefined => {
    const choice = canvasShareChoice(bot, ref, canvas);
    if (!choice) return undefined;
    return {
      label: choice.label,
      onSelect: () => void setBotCanvas(bot.botId, choice.command, `${ref.source}:${ref.sessionId}`),
    };
  };
}
