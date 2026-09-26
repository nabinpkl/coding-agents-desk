// One Bot card's head: its face, its name, what it is pointed at, and its controls.
//
// Apart from the card because the card is the roster of sessions and their grips, and the head
// is the Bot itself: carrying the whole card by this band, counting and summarising what stands
// below it, and holding every control that acts on the Bot rather than on one session. What the
// head says about counts is said about the sessions the canvas is showing, so the card hands
// over the numbers and the head words them.

import { Plus } from "lucide-react";
import { useRef } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { ActivityDot } from "@/features/sidebar/SessionMeta";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { BotCardMenu } from "@/features/bots/menus/BotCardMenu";
import { BotCodeButton } from "@/features/bots/code/BotCodeButton";
import { BotGitButton } from "@/features/bots/git/BotGitButton";
import { BotTerminalButton } from "@/features/bots/BotTerminalButton";
import { useBotGitStatus } from "@/features/bots/git/useBotGitStatus";

export function BotCanvasHeader({
  bot,
  hue,
  rank,
  machineLabel,
  feed,
  sessionCount,
  liveCount,
  hiddenCount,
  onMoveStart,
  onMoveBy,
  onMoveEnd,
  onMoveBySteps,
  canMoveLeft,
  canMoveRight,
  onAddSession,
  onDetachBot,
  onRenameBot,
  onDeleteBot,
}: {
  bot: BotView;
  /** This Bot's place on the colour wheel, or nothing if the roster does not know it yet. */
  hue: number | undefined;
  /** This Bot's rank in the creation order. Draws the face. */
  rank: number | undefined;
  /** The machine this Bot's directory is on, or absent when the canvas is showing only one. */
  machineLabel?: string;
  /** The sidecar that owns this Bot's directory, for the header's buttons. */
  feed: SidecarDataSource;
  /** The Bot's sessions this canvas is showing, and the live and hidden counts beside them. */
  sessionCount: number;
  liveCount: number;
  hiddenCount: number;
  /** Carrying the whole card by this band. See below for why a press waits before it carries. */
  onMoveStart: (clientX: number) => void;
  onMoveBy: (clientX: number) => void;
  onMoveEnd: () => void;
  /** The keyboard's way to the same thing: one place left or right in the order. */
  onMoveBySteps: (steps: number) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onAddSession: (bot: BotView) => void;
  onDetachBot: (bot: BotView) => void;
  /** Opens the dialog that renames this Bot and restyles its face. */
  onRenameBot: (bot: BotView) => void;
  /** Forgets this Bot; its sessions survive. */
  onDeleteBot: (bot: BotView) => void;
}) {
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  // One subscription for the header: the git button counts from it, and the code button re-reads
  // what it shows whenever it moves. From the card's own feed, because a peer's Bot is a directory
  // on the peer, and asking this Mac's git about it would answer about a path it may not have.
  const git = useBotGitStatus(
    feed,
    bot.botId,
    bot.environmentAvailability === "available",
  );
  // A press on the header is a click until it has travelled far enough to be a carry. Without that
  // threshold the header's own buttons would fire a move on every tap, and a hand that shifts two
  // pixels while clicking "Add sessions" would reorder the canvas.
  const grab = useRef<{ pointerId: number; startX: number; carrying: boolean } | null>(null);
  const MOVE_THRESHOLD = 4;
  const grabHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Never from a control. The header holds the add button and the Bot's menu, and a drag that
    // began on either would swallow the press that was meant for it.
    if ((event.target as HTMLElement).closest("button")) return;
    grab.current = { pointerId: event.pointerId, startX: event.clientX, carrying: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const carryHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.carrying) {
      if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD) return;
      held.carrying = true;
      onMoveStart(held.startX);
    }
    onMoveBy(event.clientX);
  };
  const dropHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    if (held.carrying) onMoveEnd();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  // A count, and the live and hidden beside it. Said over the sessions the canvas is showing
  // rather than over the Bot's whole roster, because those are what stand below this head.
  const counted = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}${
    liveCount > 0 ? `, ${liveCount} live` : ""
  }${hiddenCount > 0 ? `, ${hiddenCount} off the canvas` : ""}`;
  return (
    // `w-0 min-w-full` is what stops the header deciding how wide the card is. A card is
    // sized by its contents, and contents are measured at MAX-content -- so the Bot's full
    // name and full project path were setting a width the sessions never asked for, and
    // `truncate` never engaged because nothing was ever constraining it. A percentage
    // min-width cannot be resolved while that measurement is happening, so the header counts
    // as zero then and stretches to the answer afterwards.
    <div
      // No background of its own. It had `bg-card` from when the card was `bg-card`, which was
      // the same colour and so invisible; now that the card carries a hue, repainting the band
      // that holds the Bot's name would be the one part of the card not wearing it.
      className="flex w-0 min-w-full shrink-0 cursor-grab items-center gap-3 border-b border-border py-2 pr-3 pl-1 select-none active:cursor-grabbing"
      onPointerDown={grabHeader}
      onPointerMove={carryHeader}
      onPointerUp={dropHeader}
      onPointerCancel={dropHeader}
    >
      <BotAvatar bot={bot} hue={hue} rank={rank} size="size-11" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
          {bot.name}
        </span>
        {/* The chip tier, not the meta tier, and that is the whole hierarchy fix on this card.
            This line is a caption bound to the name above it -- where the Bot runs and what it
            is pointed at -- while the session titles below it are the card's content, the
            thing a reader scans a canvas for. Both were 13px, so the only separation was
            weight and ink, and size was arguing against them: measured on the live canvas,
            "dev · agent-desk" and "AD Project manager" sat at the same optical level.
            11px also puts this line where the SIDEBAR has always drawn it, so one Bot now
            reads the same way in both places instead of two. */}
        <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
          {bot.metadata.role ? `${bot.metadata.role} · ` : ""}
          {machineLabel ? <span className="font-medium">{machineLabel}</span> : null}
          {machineLabel ? " · " : ""}
          <span className="font-mono">{projectName}</span>
          {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
        </span>
      </span>
      {/* A count, not a sentence. "3 sessions" said in a header sitting over three sessions is
          a word spent naming what is directly underneath it; the number is the only part that
          was carrying anything. The dot is there only when something is live, which is the one
          thing the spines below cannot tell you at a glance once there are several. */}
      <span
        className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground"
        title={counted}
      >
        {liveCount > 0 ? <ActivityDot activity="live" /> : null}
        <span aria-hidden>{sessionCount}</span>
        <span className="sr-only">{counted}</span>
      </span>
      <BotCodeButton bot={bot} feed={feed} git={git} />
      <BotGitButton bot={bot} feed={feed} git={git} />
      <BotTerminalButton bot={bot} feed={feed} />
      <button
        type="button"
        onClick={() => onAddSession(bot)}
        disabled={bot.environmentAvailability === "missing"}
        // Named for its Bot: a canvas of eight cards would otherwise give a screen reader eight
        // identically named buttons with no way to tell which card it is on.
        aria-label={`Add sessions to ${bot.name}`}
        title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : "Add sessions"}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="size-4" aria-hidden />
      </button>
      {/* Beside the add button rather than in it: one adds sessions to the Bot, the other
          takes the whole Bot off the canvas, and they are not the same scale of act. */}
      <BotCardMenu
        bot={bot}
        onDetach={() => onDetachBot(bot)}
        onMoveLeft={canMoveLeft ? () => onMoveBySteps(-1) : undefined}
        onMoveRight={canMoveRight ? () => onMoveBySteps(1) : undefined}
        onRenameBot={() => onRenameBot(bot)}
        onDeleteBot={() => onDeleteBot(bot)}
      />
    </div>
  );
}
