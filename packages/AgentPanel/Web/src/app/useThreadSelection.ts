// Which thread is open, how it is read, and how it is reopened after a reload.
//
// One selection, addressed three ways -- picked from the catalog, picked from a Bot, or restored
// from storage -- and two reader preferences that outlive it. The preferences are here rather
// than inside the session view because they survive switching threads: everything a session owns
// is replaced with the session, and these two deliberately are not.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary, SessionSummary, BotView } from "@agentdesk/agent-feed-wire";
import type { EventMode } from "../features/activity-feed/data-source/AgentDataSource";
import { loadEventMode, storeEventMode } from "../features/activity-feed/eventModeStore";
import { loadCacheHitsVisible, storeCacheHitsVisible } from "../features/activity-feed/cacheHitStore";
import { storeSelection, type RememberedSelection } from "../features/sidebar/selectionStore";

interface SelectedThread {
  project: ProjectSummary;
  session: SessionSummary;
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

  const openBotSession = useCallback((bot: BotView, session: SessionSummary) => {
    const project = projects.find((candidate) => candidate.projectPath === bot.environment.path) ?? {
      projectPath: bot.environment.path,
      displayName: bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path,
      sourceCounts: { [session.source]: 1 },
      sessionCount: 1,
      lastEventAt: session.lastEventAt,
    };
    setSelectedBotId(bot.botId);
    openSession(project, session);
  }, [openSession, projects]);

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
  };
}
