// Everything all three renderings of the sidebar are handed.
//
// Built once, not per mount: the pinned desktop rail, the hover preview and the phone drawer show
// the same list from the same subscription, and only two are ever mounted at once. Its own file
// because it is the seam where the panel's five state groups meet the sidebar's props, and that
// list is long enough to bury the shell it used to sit in.

import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { useBots } from "@/features/bots/useBots";
import type { useDesktopPark } from "@/features/desktop-park/useDesktopPark";
import type { useUsage } from "@/features/usage/useUsage";
import type { useSidebarChrome } from "@/app/shell-state/useSidebarChrome";
import type { useProjectInventory } from "@/app/shell-state/useProjectInventory";
import type { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import type { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { useThreadSelection } from "@/app/shell-state/useThreadSelection";
import type { usePiSessionCreation } from "@/app/shell-state/usePiSessionCreation";

export function sidebarProps({
  botsState,
  chrome,
  commands,
  creatingProjectPath,
  creationErrors,
  createPiSession,
  inventory,
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
  inventory: ReturnType<typeof useProjectInventory>;
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
    projects: inventory.projects,
    sessionsByProject: inventory.sessionsByProject,
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
    bots: botsState.bots,
    botsLoading: botsState.loading,
    botsError: botsState.error,
    selectedBotId: thread.selectedBotId,
    onSelectBotSession: thread.openBotSession,
    onAddBotSession: commands.openBotSessionPicker,
    onDetachBotSession: commands.detachBotSession,
    onRenameSession: commands.setRenamingSession,
    detachedBotIds: roster.detachedBotIds,
    onToggleBotOnCanvas: roster.toggleBotOnCanvas,
    detachedSessionKeys: roster.detachedSessionKeys,
    canvasOpenSessionKeys: roster.canvasOpenKeys,
    onOpenSessionOnCanvas: roster.openSessionOnCanvas,
    onAddBot: () => {
      commands.setBotCreatorOpen(true);
      chrome.setHoverPreviewOpen(false);
    },
  };
}
