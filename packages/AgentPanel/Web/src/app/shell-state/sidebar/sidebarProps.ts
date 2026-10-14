// Everything all three renderings of the sidebar are handed.
//
// Built once, not per mount: the pinned desktop rail, the hover preview and the phone drawer show
// the same list from the same subscription, and only two are ever mounted at once. Its own file
// because it is the seam where the panel's five state groups meet the sidebar's props, and that
// list is long enough to bury the shell it used to sit in.

import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { useBots } from "@/features/bots/useBots";
import type { useDesktopPark } from "@/features/desktop-park/useDesktopPark";
import type { useMessages } from "@/features/messages/useMessages";
import type { useUsage } from "@/features/usage/useUsage";
import type { useSidebarChrome } from "@/app/shell-state/sidebar/useSidebarChrome";
import type { useShellInventory } from "@/app/shell-state/useShellInventory";
import type { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import type { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { ShellMachines } from "@/app/shell-state/useBotMachines";
import { botsOnShownMachines, machineIsHidden } from "@/features/bots/botMachines";
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
  inventory,
  machines,
  messages,
  newSession,
  park,
  roster,
  thread,
  usage,
}: {
  botsState: ReturnType<typeof useBots>;
  chrome: ReturnType<typeof useSidebarChrome>;
  commands: ReturnType<typeof useBotCommands>;
  creatingProjectPath: ReturnType<typeof usePiSessionCreation>["creatingProjectPath"];
  creationErrors: ReturnType<typeof usePiSessionCreation>["creationErrors"];
  createPiSession: ReturnType<typeof usePiSessionCreation>["createPiSession"];
  inventory: ReturnType<typeof useShellInventory>["inventory"];
  machines: ShellMachines;
  messages: ReturnType<typeof useMessages>;
  newSession: ReturnType<typeof useNewSessionCommands>;
  park: ReturnType<typeof useDesktopPark>;
  roster: ReturnType<typeof useCanvasRoster>;
  thread: ReturnType<typeof useThreadSelection>;
  usage: ReturnType<typeof useUsage>;
}) {
  return {
    mode: chrome.sidebarMode,
    onModeChange: chrome.changeSidebarMode,
    usage,
    park,
    messages,
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
    botMachineLabels: machines.labels,
    // The roster rows' terminal button opens a shell in the Bot's own directory, on the machine
    // that owns it -- the same lookup every Bot command already routes through.
    feedForBot: (botId: string) => machines.feeds.forBot(botId),
    botsLoading: botsState.loading,
    botsError: botsState.error,
    selectedBotId: thread.selectedBotId,
    onSelectBotSession: thread.openBotSession,
    onAddBotSession: commands.openBotSessionPicker,
    onDetachBotSession: commands.detachBotSession,
    onSetFatherBotSession: commands.setFatherBotSession,
    onRenameSession: commands.setRenamingSession,
    detachedBotIds: roster.detachedBotIds,
    onToggleBotOnCanvas: roster.toggleBotOnCanvas,
    // Over the WHOLE roster rather than over the Bots on the canvas, because the rows this marks
    // include the ones already taken off it: a Bot that is both detached and on a hidden machine
    // is off the canvas twice, and its row must not offer to put it back with one press.
    machineHiddenBotIds: new Set(
      botsState.bots
        .filter((bot) => machineIsHidden(roster.hiddenMachines, machines.keyOfBot, bot.botId))
        .map((bot) => bot.botId),
    ),
    // Counted over the Bots ON the canvas rather than over the whole roster, and over all of them
    // rather than over the ones a shown machine is contributing: the number beside a hidden
    // machine's chip is what says how many cards pressing it would bring back.
    //
    // `shown` is the strip's own count, through the filter the strip itself draws with, so "7 of 8"
    // can never name a canvas holding six.
    canvasMachines: {
      total: roster.canvasBots.length,
      shown: botsOnShownMachines(
        roster.canvasBots,
        roster.hiddenMachines,
        machines.keyOfBot,
      ).length,
      machines: machines.chips,
      hidden: roster.hiddenMachines,
      countOf: (key: string) =>
        roster.canvasBots.filter((bot) => machines.keyOfBot(bot.botId) === key).length,
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
      canvasMove: { held: roster.heldSessionKeys, onMove: roster.moveListedSessionToCanvas },
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
      onNewSession: () => {
        newSession.openDialog();
        chrome.setHoverPreviewOpen(false);
      },
    },
    onAddBot: () => {
      commands.setBotCreatorOpen(true);
      chrome.setHoverPreviewOpen(false);
    },
  };
}
