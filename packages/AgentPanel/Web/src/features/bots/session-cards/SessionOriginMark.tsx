// The mark before a session's name when it was made from another one: a fork of it, or a handover
// of its context to the other harness. Drawn wherever a Bot's session is named, on its canvas card
// and in the sidebar's roster, so one session reads the same in both.
//
// A mark rather than words in the title (the owner's call, 2026-10-24), so a narrow card's name
// keeps only the anchor and the task: `Gina (tide pools)`, not `Gina (tide pools) (fork)`. The icons
// are the ones the session's menu offers those two acts with, so a reader who has used them knows
// the mark. Which session it came from is its hover text. On the card the row's content takes no
// pointer events of its own (`BotSessionCard`), so a press on the mark opens the card like any other
// press on the row, and the row's button carries the same text instead.

import { ArrowRightLeft, GitFork } from "lucide-react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { sessionKey } from "@/features/bots/cards/botCanvasCards";

export interface SessionOrigin {
  kind: "fork" | "handover";
  /** `Forked from Emma`, naming the source by its anchor on this Bot. */
  text: string;
}

/** Where this session came from, as the Bot recorded it, or undefined for one started fresh. */
export function sessionOrigin(bot: BotView, session: SessionSummary): SessionOrigin | undefined {
  const origin = bot.sessionOrigins?.[sessionKey(session)];
  if (!origin) return undefined;
  // The anchor outlives a detach, so a source that has left the Bot is still named by it.
  const source =
    bot.sessionAnchors?.[sessionKey(origin.from)] ??
    bot.sessions.find((one) => sessionKey(one) === sessionKey(origin.from))?.title ??
    "another session";
  return { kind: origin.kind, text: `${origin.kind === "fork" ? "Forked" : "Handed over"} from ${source}` };
}

/**
 * The mark, inline at the start of a name: sized to its 13px cap height and set on its baseline, in
 * the caption's ink, so it reads as part of the name rather than as a control beside it. Nothing for
 * a session started fresh.
 */
export function SessionOriginMark({ origin }: { origin: SessionOrigin | undefined }) {
  if (!origin) return null;
  const Mark = origin.kind === "fork" ? GitFork : ArrowRightLeft;
  return (
    <span
      role="img"
      aria-label={origin.text}
      title={origin.text}
      className="mr-1 inline-flex align-[-2px] session-muted-ink"
    >
      <Mark className="size-3.5" aria-hidden />
    </span>
  );
}

/** A canvas card's name, after its mark. */
export function SessionCardName({ title, origin }: { title: string; origin: SessionOrigin | undefined }) {
  return (
    <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
      <SessionOriginMark origin={origin} />
      {title}
    </span>
  );
}
