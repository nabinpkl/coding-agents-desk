// Which thread is open, how it is read, and how it is reopened after a reload.
//
// One selection, addressed three ways -- picked from the catalog, picked from a Bot, or restored
// from storage -- and two reader preferences that outlive it. The preferences are here rather
// than inside the session view because they survive switching threads: everything a session owns
// is replaced with the session, and these two deliberately are not.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary, SessionSummary, BotView } from "@agentdesk/agent-feed-wire";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { loadEventMode, storeEventMode } from "@/features/activity-feed/reading-preferences/eventModeStore";
import { loadCacheHitsVisible, storeCacheHitsVisible } from "@/features/activity-feed/reading-preferences/cacheHitStore";
import { storeSelection, type RememberedSelection } from "@/features/sidebar/selectionStore";

interface SelectedThread {
  project: ProjectSummary;
  session: SessionSummary;
}

/**
 * A session read in the modal. `botId` when it was opened from a Bot's card, which is what lets the
 * modal reach the machine that Bot is on rather than the one the tab bar's picker points at.
 */
interface ModalThread extends SelectedThread {
  botId?: string;
}

export function useThreadSelection({
  projects,
  sessionsByProject,
  rememberedSelection,
  setBotCommandError,
  setHoverPreviewOpen,
  setSidebarOpen,
  usesModalSidebar,
}: {
  projects: ProjectSummary[];
  sessionsByProject: Map<string, SessionSummary[]>;
  /** Read once at mount by the caller, because storage is written on every selection. */
  rememberedSelection: RememberedSelection | null;
  setBotCommandError: (error: null) => void;
  setHoverPreviewOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  usesModalSidebar: boolean;
}) {
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  // A session read over the canvas, apart from the selection: the canvas has no thread of its own,
  // and opening one there must not change what the Sessions tab comes back to.
  const [modalThread, setModalThread] = useState<ModalThread | null>(null);
  const restoredSelection = useRef(false);
  // Owned here rather than in the feed so the choice survives switching threads, and
  // so the feed can remount on a change -- every event index it holds is counted in
  // the mode, so none of them survives a switch.
  const [eventMode, setEventMode] = useState<EventMode>(loadEventMode);
  const toggleEventMode = useCallback(() => {
    setEventMode((current) => {
      const next = current === "nice" ? "raw" : "nice";
      storeEventMode(next);
      return next;
    });
  }, []);

  // Pure presentation: per-turn cache badges on rows that carry the data.
  // Owned here (like the mode) so the choice survives switching threads.
  const [showCacheHits, setShowCacheHits] = useState<boolean>(loadCacheHitsVisible);
  const toggleCacheHits = useCallback(() => {
    setShowCacheHits((current) => {
      const next = !current;
      storeCacheHitsVisible(next);
      return next;
    });
  }, []);

  /**
   * Opens a thread.
   *
   * Nothing about the previous thread is cleared here any more. Everything a session owns --
   * its run state, its usage, its open question, its extension prompts, its terminal -- lives in
   * the `SessionView` below, which is keyed on the session and so is REPLACED rather than reset.
   * The mode is the exception, because it is a reader's preference rather than a session's state:
   * it survives the switch, narrowed to what the incoming session can actually serve.
   */
  const openSession = useCallback(
    (project: ProjectSummary, session: SessionSummary) => {
      setEventMode((current) => session.capabilities.modes.includes(current)
        ? current
        : (session.capabilities.modes[0] ?? "nice"));
      setBotCommandError(null);
      setSelectedThread({ project, session });
      storeSelection({
        projectPath: project.projectPath,
        source: session.source,
        sessionId: session.sessionId,
      });
      setHoverPreviewOpen(false);
      if (usesModalSidebar) setSidebarOpen(false);
    },
    [setSidebarOpen, usesModalSidebar],
  );

  const openCatalogSession = useCallback((project: ProjectSummary, session: SessionSummary) => {
    setSelectedBotId(null);
    openSession(project, session);
  }, [openSession]);

  // A Bot's directory as a project, made up when the inventory has none for it: a peer's Bot, or a
  // directory no session has reported from yet.
  const projectOfBot = useCallback((bot: BotView, session: SessionSummary): ProjectSummary =>
    projects.find((candidate) => candidate.projectPath === bot.environment.path) ?? {
      projectPath: bot.environment.path,
      displayName: bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path,
      sourceCounts: { [session.source]: 1 },
      sessionCount: 1,
      lastEventAt: session.lastEventAt,
    }, [projects]);

  const openBotSession = useCallback((bot: BotView, session: SessionSummary) => {
    setSelectedBotId(bot.botId);
    openSession(projectOfBot(bot, session), session);
  }, [openSession, projectOfBot]);

  const openSessionInModal = useCallback((project: ProjectSummary, session: SessionSummary) => {
    setModalThread({ project, session });
    setHoverPreviewOpen(false);
    if (usesModalSidebar) setSidebarOpen(false);
  }, [setHoverPreviewOpen, setSidebarOpen, usesModalSidebar]);
  const openBotSessionInModal = useCallback((bot: BotView, session: SessionSummary) => {
    setModalThread({ project: projectOfBot(bot, session), session, botId: bot.botId });
    setHoverPreviewOpen(false);
  }, [projectOfBot, setHoverPreviewOpen]);
  const closeSessionModal = useCallback(() => setModalThread(null), []);

  /**
   * Reopen whatever was on screen before the last reload.
   *
   * Runs once, and only while nothing is selected: a viewer who has already picked a thread must
   * never have it changed under them by a late inventory delivery.
   *
   * It waits for the session list rather than acting on the stored id directly, because the row it
   * restores carries live state -- capabilities decide which modes the thread can open in, and a
   * fabricated summary would open a thread in a view its source does not serve. A session that has
   * since been deleted simply never matches, and the panel opens on its empty state.
   */
  useEffect(() => {
    if (restoredSelection.current || selectedThread) return;
    const remembered = rememberedSelection;
    if (!remembered) return;
    const project = projects.find((entry) => entry.projectPath === remembered.projectPath);
    const session = sessionsByProject.get(remembered.projectPath)
      ?.find((entry) => entry.sessionId === remembered.sessionId && entry.source === remembered.source);
    if (!project || !session) return;
    restoredSelection.current = true;
    openSession(project, session);
  }, [projects, rememberedSelection, sessionsByProject, selectedThread, openSession]);

  return {
    selectedThread,
    selectedBotId,
    setSelectedBotId,
    eventMode,
    toggleEventMode,
    showCacheHits,
    toggleCacheHits,
    openSession,
    openCatalogSession,
    openBotSession,
    modalThread,
    openSessionInModal,
    openBotSessionInModal,
    closeSessionModal,
  };
}
