// Everything all three renderings of the sidebar are handed.
//
// Built once, not per mount: the pinned desktop rail, the hover preview and the phone drawer show
// the same list from the same subscription, and only two are ever mounted at once. Its own file
// because it is the seam where the panel's five state groups meet the sidebar's props, and that
// list is long enough to bury the shell it used to sit in.

import type { BotView, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { useBots } from "@/features/bots/useBots";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { useSidebarChrome } from "@/app/shell-state/sidebar/useSidebarChrome";
import type { useShellInventory } from "@/app/shell-state/useShellInventory";
import type { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import type { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { ShellMachines } from "@/app/shell-state/useBotMachines";
import { botsOnShownMachines, machineIsHidden } from "@/features/bots/botMachines";
import { botSessionFaces } from "@/features/bots/avatar/botSessionFaces";
import type { useThreadSelection } from "@/app/shell-state/useThreadSelection";
import type { usePiSessionCreation } from "@/app/shell-state/usePiSessionCreation";
import type { useNewSessionCommands } from "@/app/shell-state/useNewSessionCommands";

export function sidebarProps({
  botsState,
  chrome,
  commands,
  creatingProjectPath,
  creationErrors,
  createPiSession,
  feed,
  inventory,
  machines,
  newSession,
  roster,
  thread,
  revealOnCanvas,
}: {
  botsState: ReturnType<typeof useBots>;
  chrome: Omit<ReturnType<typeof useSidebarChrome>, "drawerTriggerRef">;
  commands: ReturnType<typeof useBotCommands>;
  creatingProjectPath: ReturnType<typeof usePiSessionCreation>["creatingProjectPath"];
  creationErrors: ReturnType<typeof usePiSessionCreation>["creationErrors"];
  createPiSession: ReturnType<typeof usePiSessionCreation>["createPiSession"];
  feed: SidecarDataSource;
  inventory: ReturnType<typeof useShellInventory>["inventory"];
  machines: ShellMachines;
  newSession: ReturnType<typeof useNewSessionCommands>;
  roster: ReturnType<typeof useCanvasRoster>;
  thread: ReturnType<typeof useThreadSelection>;
  /** Asks the canvas to bring a session's card into view, once it is drawn (`canvasStore`). */
  revealOnCanvas: (key: string) => void;
}) {
  // Over the WHOLE roster rather than over the Bots on the canvas, because the roster rows this
  // marks include the ones already taken off it: a Bot that is both detached and on a hidden
  // machine is off the canvas twice, and its row must not offer to put it back with one press.
  // The Sessions view's faces read it too, to leave a session with no card unshaded.
  const machineHiddenBotIds = new Set(
    botsState.bots
      .filter((bot) => machineIsHidden(roster.hiddenMachines, machines.keyOfBot, bot.botId))
      .map((bot) => bot.botId),
  );
  return {
    mode: chrome.sidebarMode,
    onModeChange: chrome.changeSidebarMode,
    canvasOnly: chrome.canvasOnly,
    feed,
    machines: machines.all,
    projects: inventory.projects,
    sessionsByProject: inventory.sessionsByProject,
    archiving: inventory.archiving,
    loading: inventory.loadingLayer,
    error: inventory.layerError,
    retrying: inventory.retrying,
    selectedProjectPath: thread.selectedThread?.project.projectPath ?? null,
    selectedSessionKey: thread.selectedThread
      ? `${thread.selectedThread.session.source}:${thread.selectedThread.session.sessionId}`
      : null,
    creatingProjectPath,
    creationErrors,
    expandedProjectPaths: inventory.expandedProjectPaths,
    onToggleProject: inventory.toggleProject,
    onSelectSession: thread.openCatalogSession,
    onCreatePiSession: (project: ProjectSummary) => void createPiSession(project),
    // The canvas's own arrangement rather than the order the machines answered in: this list and
    // the strip are the same Bots, so a reader who moves a card has moved this row with it.
    bots: roster.orderedBots,
    colourBots: machines.colourBots,
    botMachineLabels: machines.labels,
    // The roster rows' terminal button opens a shell in the Bot's own directory, on the machine
    // that owns it. Read as of this render, because the rows ask while they draw.
    feedForBot: (botId: string) => machines.feedOfBot(botId),
    botsLoading: botsState.loading,
    botsError: botsState.error,
    selectedBotId: thread.selectedBotId,
    onSelectBotSession: thread.openBotSession,
    // A draft card on the canvas, which the phone's drawer covers. The dormant Bots tab draws no
    // canvas, so there it is still the Add sessions dialog.
    onAddBotSession: (bot: BotView) => {
      if (chrome.sidebarMode !== "canvas") return commands.openBotSessionPicker(bot.botId);
      commands.addSessionDraft(bot);
      if (chrome.usesModalSidebar) chrome.setSidebarOpen(false);
    },
    onDetachBotSession: commands.detachBotSession,
    onSetFatherBotSession: commands.setFatherBotSession,
    onRenameSession: commands.setRenamingSession,
    detachedBotIds: roster.detachedBotIds,
    onToggleBotOnCanvas: roster.toggleBotOnCanvas,
    machineHiddenBotIds,
    // Counted over the Bots ON the canvas rather than over the whole roster, and over all of them
    // rather than over the ones a shown machine is contributing: the number beside a hidden
    // machine's chip is what says how many cards pressing it would bring back.
    //
    // `shown` is the strip's own count, through the filter the strip itself draws with, so "7 of 8"
    // can never name a canvas holding six.
    canvasMachines: {
      total: roster.canvasBots.length,
      shown: botsOnShownMachines(roster.canvasBots, roster.hiddenMachines, machines.keyOfBot).length,
      machines: machines.chips,
      hidden: roster.hiddenMachines,
      countOf: (key: string) => roster.canvasBots.filter((bot) => machines.keyOfBot(bot.botId) === key).length,
      onToggle: roster.toggleMachineOnCanvas,
      // Beside the machine chips because it answers the same kind of question they do: not which
      // Bots are on the canvas, but how much of the canvas the reader can see at once.
      zoom: { on: roster.canvasZoomMode, onToggle: roster.toggleCanvasZoom },
      // Beside the mode it belongs to: it is the room the fitted canvas gets to be moved around
      // in, and it does nothing at all while the canvas is drawn at its own size.
      room: { size: roster.canvasRoom, onChange: roster.setCanvasRoom },
    },
    detachedSessionKeys: roster.detachedSessionKeys,
    canvasOpenSessionKeys: roster.canvasOpenKeys,
    onOpenSessionOnCanvas: roster.openSessionOnCanvas,
    // Beside it because it is the same act with a session attached first: `/new` and `/fork` make
    // one, and a Bot is a curated view over transcripts it does not own, so a made session that
    // nobody attached belongs to nobody.
    attachSessionToBot: roster.attachSessionToBot,
    canvasView: chrome.sidebarPreferences.canvasView,
    onCanvasViewChange: chrome.changeCanvasView,
    canvasSessions: {
      onOpen: thread.openSessionInModal,
      canvasMove: {
        held: roster.heldSessionKeys,
        onMove: roster.moveListedSessionToCanvas,
        // What a press on the session's row in the Bots view does, then the scroll to its card. The
        // first Bot holding it, which is also the Bot whose face its row wears.
        onShow: (session: SessionSummary) => {
          const bot = roster.orderedBots.find((each) =>
            each.sessionRefs.some((ref) => ref.source === session.source && ref.sessionId === session.sessionId),
          );
          if (!bot) return;
          roster.openSessionOnCanvas(bot, session);
          revealOnCanvas(`${session.source}:${session.sessionId}`);
        },
      },
      // From the same roster, sets and open cards the Bots view draws its rows from, so a session
      // wears one face in both views.
      faces: botSessionFaces(
        roster.orderedBots,
        {
          detachedBotIds: roster.detachedBotIds,
          machineHiddenBotIds,
          detachedSessionKeys: roster.detachedSessionKeys,
          openSessionKeys: roster.canvasOpenKeys,
        },
        machines.colourBots,
      ),
      modalSelection: thread.modalThread
        ? {
            projectPath: thread.modalThread.project.projectPath,
            sessionKey: `${thread.modalThread.session.source}:${thread.modalThread.session.sessionId}`,
          }
        : null,
      grouped: chrome.sidebarPreferences.canvasSessionsGrouped,
      onGroupedChange: chrome.changeCanvasSessionsGrouped,
      recent: inventory.recent,
      onShowMore: inventory.showMoreRecent,
      reconnecting: inventory.reconnecting,
      reviews: {
        open: inventory.recentReviewsOpen,
        onToggle: inventory.toggleRecentReviews,
        onShowMore: inventory.showMoreRecentReviews,
      },
      onNewSession: () => {
        newSession.openDialog();
        chrome.setHoverPreviewOpen(false);
      },
      onNewChat: () => {
        newSession.openChat();
        chrome.setHoverPreviewOpen(false);
      },
    },
    onAddBot: () => {
      commands.setBotCreatorOpen(true);
      chrome.setHoverPreviewOpen(false);
    },
  };
}
