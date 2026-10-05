// One Bot card's head: its face, its name, what it is pointed at, and its controls.
//
// Apart from the card because the card is the roster of sessions and their grips, and the head
// is the Bot itself: carrying the whole card by this band and holding every control that acts
// on the Bot rather than on one session.
//
// WHICH controls are in the row is a fact about this card's width and not about the Bot, because
// a card is exactly as wide as the sessions standing in it: a Bot with one short-named session is
// narrow while its neighbour is not, on the same strip. A narrow card spends its width on the
// name and the add button, and the code, git and terminal controls move into the more menu beside
// it -- the same controls, the same dialogs, one owner each. See `useNarrowHeader` for the
// measurement and the threshold, and `BotCardMenu` for where the moved entries land.

import { CodeXml, GitBranch, Plus, Terminal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { BotCardMenu } from "@/features/bots/menus/BotCardMenu";
import type { RowMenuItem } from "@/features/bots/menus/RowMenu";
import { BotCodeButton } from "@/features/bots/code/BotCodeButton";
import { BotCodeDialog } from "@/features/bots/code/BotCodeDialog";
import type { FilePathTarget } from "@/features/activity-feed/markdown/filePathLinks";
import { BotGitButton, BotGitUnavailable, gitHeaderAction } from "@/features/bots/git/BotGitButton";
import { useBotGitStatus } from "@/features/bots/git/useBotGitStatus";
import { BotTerminalButton, BotTerminalDialog } from "@/features/bots/BotTerminalButton";
import { useNarrowHeader } from "@/features/bots/cards/useNarrowHeader";

/** The dialogs a narrow card opens from its more menu, where no button in the row owns them. */
type HeaderDialog = "code" | "git" | "terminal";

export function BotCanvasHeader({
  bot,
  hue,
  rank,
  machineLabel,
  feed,
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
  fileRequest,
  onCloseFile,
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
  /**
   * A file one of this Bot's sessions named in its transcript and the reader clicked, opened in
   * the code dialog here because this is where the Bot's git subscription lives.
   */
  fileRequest: FilePathTarget | null;
  onCloseFile: () => void;
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
  const header = useRef<HTMLDivElement | null>(null);
  const narrow = useNarrowHeader(header);
  // Only the narrow path opens dialogs from here, and only one at a time. The wide path's dialogs
  // belong to the buttons in the row, which are not rendered there -- the same arrangement the
  // canvas uses for the Father home, where one stand gives way to the other rather than both
  // holding the same state.
  const [dialog, setDialog] = useState<HeaderDialog | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const gitAction = gitHeaderAction(git);
  // A missing directory has no code to browse, no git to read and nowhere to land a terminal, so
  // the row's controls are all disabled on it and the menu has nothing to offer. The caption
  // already says the directory is missing, which is the one thing a reader needs.
  const hasDirectory = bot.environmentAvailability !== "missing";
  const overflow: RowMenuItem[] | undefined = !narrow
    ? undefined
    : !hasDirectory
      ? []
      : [
        { label: "Browse code", icon: CodeXml, onSelect: () => setDialog("code") },
        ...(gitAction.kind === "changes"
          ? [{
            label: gitAction.count > 0 ? `Show git changes (${gitAction.label})` : "Show git changes",
            icon: GitBranch,
            onSelect: () => setDialog("git"),
          }]
          : []),
        { label: "Open terminal", icon: Terminal, onSelect: () => setDialog("terminal") },
      ];
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
  return (
    <>
    {/* `w-0 min-w-full` is what stops the header deciding how wide the card is. A card is
        sized by its contents, and contents are measured at MAX-content -- so the Bot's full
        name and full project path were setting a width the sessions never asked for, and
        `truncate` never engaged because nothing was ever constraining it. A percentage
        min-width cannot be resolved while that measurement is happening, so the header counts
        as zero then and stretches to the answer afterwards. It is also what makes this header
        measureable at all: its own box is the card's width rather than anything this row chose,
        which is the number `useNarrowHeader` reads. */}
    <div
      ref={header}
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
      {/*
        The three directory controls, in the row while it has room and in the more menu while it
        does not. The git mark is the exception and stays in the row either way: it is a fact about
        the Bot rather than a way in, and a row that cannot spare a control can still spare a fact.
      */}
      {gitAction.kind === "unreadable" ? (
        <BotGitUnavailable error={gitAction.error} />
      ) : narrow ? null : (
        <>
          <BotCodeButton bot={bot} feed={feed} git={git} />
          {/* Nothing to say for a directory with no repository, which the button decides itself. */}
          <BotGitButton bot={bot} feed={feed} git={git} />
          <BotTerminalButton bot={bot} feed={feed} />
        </>
      )}
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
        overflow={overflow}
        onDetach={() => onDetachBot(bot)}
        onMoveLeft={canMoveLeft ? () => onMoveBySteps(-1) : undefined}
        onMoveRight={canMoveRight ? () => onMoveBySteps(1) : undefined}
        onRenameBot={() => onRenameBot(bot)}
        onDeleteBot={() => onDeleteBot(bot)}
      />
    </div>
    {/* The dialogs a narrow card opened from its menu, which the row's own buttons do not own
        there. One of the two paths is ever mounted: `narrow` decides which. */}
    {dialog === "code" || dialog === "git" ? (
      <BotCodeDialog
        bot={bot}
        feed={feed}
        git={git}
        initialSection={dialog === "git" ? "sourceControl" : "explorer"}
        onClose={closeDialog}
      />
    ) : null}
    {fileRequest !== null ? (
      <BotCodeDialog
        // A different file is a fresh look, opened where that file is.
        key={`${fileRequest.path}:${fileRequest.line ?? ""}`}
        bot={bot}
        feed={feed}
        git={git}
        initialSection="explorer"
        initialFile={fileRequest}
        onClose={onCloseFile}
      />
    ) : null}
    {dialog === "terminal" ? (
      <BotTerminalDialog bot={bot} feed={feed} onClose={closeDialog} />
    ) : null}
    </>
  );
}
