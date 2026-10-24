// A session row's name, and the mark before it when the session was made from another: a fork of
// it, or a handover of its context to the other harness.
//
// A mark rather than words in the title (the owner's call, 2026-10-24), so a narrow card's name
// keeps only the anchor and the task: `Gina (tide pools)`, not `Gina (tide pools) (fork)`. The icons
// are the ones the session's menu offers those two acts with, so a reader who has used them knows
// the mark. Which session it came from is the row's hover text, because the row's content takes no
// pointer events of its own (`BotSessionCard`) and a press on the mark has to open the card like
// any other press on the row.

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

export function SessionCardName({ title, origin }: { title: string; origin: SessionOrigin | undefined }) {
  const Mark = origin?.kind === "fork" ? GitFork : ArrowRightLeft;
  return (
    <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
      {origin ? (
        <Mark
          // Sized to the name's cap height and set on its baseline, in the caption's ink, so it
          // reads as part of the name rather than as a control beside it.
          className="mr-1 inline-block size-3.5 align-[-2px] session-muted-ink"
          role="img"
          aria-label={origin.text}
        />
      ) : null}
      {title}
    </span>
  );
}
