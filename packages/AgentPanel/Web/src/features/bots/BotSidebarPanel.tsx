import { Bot, LoaderCircle, Plus, ScanFace } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { setBotFaces, useBotFaces } from "@/features/bots/avatar/BotFace";
import { BotRosterRow } from "@/features/bots/BotRosterRow";
import { withOffCanvasLast } from "@/features/bots/botRosterOrder";
import { botCanvasHues, botCanvasRanks } from "@/features/bots/botSurface";

export function BotSidebarPanel({
  bots,
  loading,
  error,
  selectedBotIds,
  selectedSessionKeys,
  onSelectSession,
  onAddSession,
  onRenameSession,
  onDetachSession,
  onAddBot,
  machineLabels,
  feedForBot,
  status,
  canvas,
}: {
  bots: BotView[];
  /**
   * Which machine each Bot is on, by id, and EMPTY when there is only one machine to be on.
   *
   * This roster lists every Bot the panel can see, and since a Bot's directory can be on a remote
   * peer that is now more than one machine's worth. Saying so here matters more than on the canvas,
   * not less: a card is a wide thing with a path on it, while a row is a name and a folder, and two
   * peers with a `projects` directory each would otherwise be two identical rows.
   */
  machineLabels?: ReadonlyMap<string, string>;
  /**
   * The sidecar that owns a Bot's directory, by id. Optional because the terminal button is absent
   * without it: tests render this roster without a shell behind it, and a row without a directory
   * shell is the roster as it always was.
   */
  feedForBot?: (botId: string) => SidecarDataSource;
  loading: boolean;
  error: string | null;
  /** Every Bot to mark. A set because the canvas opens as many cards as it is asked to. */
  selectedBotIds: ReadonlySet<string>;
  selectedSessionKeys: ReadonlySet<string>;
  onSelectSession: (bot: BotView, session: SessionSummary) => void;
  onAddSession: (bot: BotView) => void;
  /** Opens the rename dialog for one session. Whichever sources `canRenameSession` admits. */
  onRenameSession: (session: SessionSummary) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched.
   *
   * Takes a reference rather than a summary because the rows that most need this are the ones
   * with no summary left: a transcript the catalog has forgotten shows as "missing" and would
   * otherwise be the one entry a Bot can never be rid of.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onAddBot: () => void;
  /**
   * Rendered between the Add Bot button and the roster.
   *
   * A slot rather than a prop of its own, because the two mounts have nothing to say to each
   * other: the Bots tab says nothing here, and the canvas says how many of these Bots are on it.
   */
  status?: ReactNode;
  /**
   * Which of these Bots are on the canvas, and how to change that. Absent in the Bots tab, which
   * is a view of the Bots themselves and has no canvas to be on.
   *
   * The set is the Bots that are OFF, the same one the canvas subtracts by, so this roster and the
   * cards cannot disagree about which is which.
   */
  canvas?: {
    detachedBotIds: ReadonlySet<string>;
    /**
     * The Bots with no card because their MACHINE is hidden, whether or not they are also
     * detached.
     *
     * Kept apart from `detachedBotIds` because they are two axes with two controls. A row here
     * dims the same way, since what a reader sees is one Bot with no card either way -- but its
     * avatar toggle is DISABLED rather than relabelled, because pressing it would move this Bot's
     * own membership and still leave the strip exactly as it was. The way back is the machine chip
     * above this roster, which is also where the count of what it is holding back is written.
     */
    machineHiddenBotIds: ReadonlySet<string>;
    /**
     * The sessions that are off the canvas, as `source:sessionId`.
     *
     * Their rows stay in this list and are dimmed, which is the whole point of taking one off: the
     * card goes, the session does not, and this is where it is found again. Clicking one is what
     * puts it back, the same click that opens any other row here.
     */
    detachedSessionKeys: ReadonlySet<string>;
    onToggle: (bot: BotView) => void;
  };
}) {
  /**
   * The same colours the canvas gives, derived here rather than passed in.
   *
   * Safe to derive twice because the derivation is a pure function of the roster, and this panel is
   * given the WHOLE roster -- it has to be, since it renders the Bots that are off the canvas too
   * and dims them. So the input is the same input the shell hands the canvas, and a Bot's face in
   * this list is the colour of its card by construction rather than by agreement.
   */
  const hues = useMemo(() => botCanvasHues(bots), [bots]);
  const ranks = useMemo(() => botCanvasRanks(bots), [bots]);
  // Colours and ranks come from the WHOLE roster and its own order, which is why they are derived
  // from `bots` and not from this: where a row sits must not change what colour it wears.
  const ordered = useMemo(
    () => withOffCanvasLast(bots, canvas),
    [bots, canvas?.detachedBotIds, canvas?.machineHiddenBotIds],
  );
  const faces = useBotFaces();
  return (
    <div className="min-h-0">
      <div className="flex items-center border-b border-border">
        <button
          type="button"
          onClick={onAddBot}
          className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-primary/15"
        >
          <Plus className="size-4" aria-hidden />
          Add Bot
        </button>
        {/* The one control for the faces switch, so both mounts of this roster move together: the
            store above is what carries the press to every avatar, including the canvas cards. Off
            until chosen -- the initials are what every reader knows, and the press is remembered
            the way the sidebar's own arrangement is. */}
        <button
          type="button"
          onClick={() => setBotFaces(!faces)}
          aria-pressed={faces}
          aria-label={faces ? "Show Bot initials instead of faces" : "Show Bot faces instead of initials"}
          title={faces ? "Showing faces" : "Showing initials"}
          className="mr-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary aria-pressed:text-primary text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
        >
          <ScanFace className="size-4" aria-hidden />
        </button>
      </div>
      {status}
      {loading ? (
        <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading Bots…
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          Bots unavailable: {error}
        </div>
      ) : bots.length === 0 ? (
        <div role="status" className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <Bot className="size-5" aria-hidden />
          No bots yet
        </div>
      ) : (
        <ul role="list" aria-label="Bots">
          {ordered.map((bot) => (
            <BotRosterRow
              key={bot.botId}
              bot={bot}
              hue={hues.get(bot.botId)}
              rank={ranks.get(bot.botId)}
              selected={selectedBotIds.has(bot.botId)}
              selectedSessionKeys={selectedSessionKeys}
              machineLabel={machineLabels?.get(bot.botId)}
              feed={feedForBot?.(bot.botId)}
              canvas={canvas}
              onSelectSession={onSelectSession}
              onAddSession={onAddSession}
              onRenameSession={onRenameSession}
              onDetachSession={onDetachSession}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
