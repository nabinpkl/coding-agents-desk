import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { GitFork, PanelLeft } from "lucide-react";
import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
  ProjectSummary,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import type {
  HostActionsClient,
} from "../features/activity-feed/data-source/HostActionsClient";
import { sidecarWindowComposerClient } from "../features/window-composer/WindowComposerClient";
import type { EventMode } from "../features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "../features/activity-feed/data-source/AgentDataSourceContext";
import { FontSizeRoot } from "../features/activity-feed/fontStore";
import { loadEventMode, storeEventMode } from "../features/activity-feed/eventModeStore";
import { loadCacheHitsVisible, storeCacheHitsVisible } from "../features/activity-feed/cacheHitStore";
import { useDesktopPark } from "../features/desktop-park/useDesktopPark";
import { useUsage } from "../features/usage/useUsage";
import {
  AgentSidebar,
  AgentSidebarDialog,
  type AgentSidebarMode,
} from "../features/sidebar/AgentSidebar";
import {
  HoverSidebarPreview,
  ResizableSidebar,
  useSidebarEnvironment,
} from "../features/sidebar/SidebarPresentation";
import {
  loadSidebarPreferences,
  storeSidebarPreferences,
} from "../features/sidebar/sidebarPreferences";
import { loadSelection, storeSelection } from "../features/sidebar/selectionStore";
import { useBots } from "../features/bots/useBots";
import { BotCanvas } from "../features/bots/BotCanvas";
import { BotCreatorDialog } from "../features/bots/BotCreatorDialog";
import { BotSessionPickerDialog } from "../features/bots/BotSessionPickerDialog";
import { SessionView } from "../features/session-view/SessionView";
import { AgentTerminalPane } from "../features/terminal/AgentTerminalPane";


/**
 * How long to wait before re-subscribing after a failure.
 *
 * Doubling from a second, capped, because the two failures worth surviving have
 * very different shapes: a sidecar restart is back within seconds, while a
 * sidecar that cannot start at all should not be asked once a second forever.
 * Each attempt already costs the host's own readiness wait, so this is the pause
 * on top of that, not the whole cadence.
 */
function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
}

interface SelectedThread {
  project: ProjectSummary;
  session: SessionSummary;
}

/**
 * The panel's two collaborators, kept apart because they are different systems.
 *
 * `feed` is the sidecar reached over HTTP: projects, threads, transcripts, commands. `host` is the
 * Mac's native authority reached by postMessage: another application's text fields and its question
 * panel. Handing the view one merged object would let a future call reach the second
 * while believing it was talking to the first.
 */
interface Props {
  feed: SidecarDataSource;
  host: HostActionsClient;
  /**
   * Fill the parent rather than the viewport.
   *
   * The default is `h-dvh` because this app is normally the whole page, and on mobile Safari the
   * dynamic viewport is the only height that tracks the browser chrome as it hides. Inside another
   * layout -- the browser tab shell, which puts a tab bar above it -- that same class overflows and
   * pushes the chrome above it off screen, so an embedder asks for the parent's height instead.
   * #root already has a definite height (styles.css), so `h-full` resolves the same chain.
   */
  fill?: boolean;
}


export function App({ feed, host, fill = false }: Props) {
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Every expanded project's sessions, owned here because they arrive on the same
  // stream as the project list. The sidebar renders what is in here; it subscribes to
  // nothing.
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionSummary[]>>(
    new Map(),
  );
  const [loadingLayer, setLoadingLayer] = useState(true);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [creatingProjectPath, setCreatingProjectPath] = useState<string | null>(null);
  const [creationErrors, setCreationErrors] = useState<Map<string, string>>(new Map());
  // A failure from a command the shell issues rather than the thread -- today, editing a Bot.
  // Handed to the open session's view, which is the only band on screen able to show it.
  const [botCommandError, setBotCommandError] = useState<string | null>(null);
  // This machine's per-day token usage, behind the sidebar's Profile section. The stream opens
  // when somebody asks for it, not on mount.
  const usage = useUsage(feed);
  // Gathering windows onto one Desktop is a machine-level capability, probed once
  // the same way usage is. Absent yabai, the menu entry stays disabled.
  const park = useDesktopPark(feed);
  // Both window composers are served by the sidecar and the standalone helper (ADR-0110). One client
  // per source, because the two resolve their window differently -- Claude by its process tree, Codex
  // by its own state joined to its accessibility tree -- and the sidecar is told which to run rather
  // than guessing. Built here rather than in the view that uses them, because they are bound to a
  // source rather than to a session and so outlive any one of them.
  const windowComposers = useMemo(
    () => ({
      claude: sidecarWindowComposerClient(feed, "claude"),
      codex: sidecarWindowComposerClient(feed, "codex"),
    }),
    [feed],
  );
  const { compact, hoverCapable } = useSidebarEnvironment();
  const [sidebarPreferences, setSidebarPreferences] = useState(loadSidebarPreferences);
  // One owner for every rendering of the sidebar: the pinned desktop rail, hover preview,
  // and phone drawer must never disagree about which view is selected.
  const [sidebarMode, setSidebarMode] = useState<AgentSidebarMode>("sessions");
  const botsState = useBots(feed);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [botCreatorOpen, setBotCreatorOpen] = useState(false);
  const [botSessionPickerId, setBotSessionPickerId] = useState<string | null>(null);
  // A catalog selection survives a trip through Bots. A Bot selection opens that same underlying
  // session, but entering Bots from Sessions still presents an empty middle panel rather than
  // relabelling the current session as a Bot.
  // Canvas has no single thread by construction: it shows the whole roster, so `main` renders the
  // canvas instead of a transcript. Everything below the transcript -- composer, summary band,
  // tasks chip, extension surface -- is already gated on this, so they stand down without a
  // condition of their own.
  const displayedThread = sidebarMode === "canvas"
    ? null
    : sidebarMode === "sessions"
      ? selectedThread
      : selectedBotId ? selectedThread : null;
  const selectedBotName = selectedBotId
    ? botsState.bots.find((bot) => bot.botId === selectedBotId)?.name
    : undefined;

  const botSessionPicker = botSessionPickerId
    ? botsState.bots.find((bot) => bot.botId === botSessionPickerId) ?? null
    : null;
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<Set<string>>(new Set());
  // The subscription's identity, not merely its argument: expanding or collapsing a
  // project reopens the inventory stream exactly once, and re-rendering for any other
  // reason leaves the open stream alone. Joined on NUL, the one byte a POSIX path
  // cannot contain, so the round trip cannot invent or lose a path.
  const subscribedProjectKey = useMemo(() => {
    const paths = [...expandedProjectPaths];
    if (botSessionPicker) paths.push(botSessionPicker.environment.path);
    return [...new Set(paths)].sort().join("\0");
  }, [botSessionPicker, expandedProjectPaths]);
  const subscribedProjectPaths = useMemo(
    () => (subscribedProjectKey === "" ? [] : subscribedProjectKey.split("\0")),
    [subscribedProjectKey],
  );
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const initializedProjectExpansion = useRef(false);
  // Read once, at mount. Storage is written on every selection, so re-reading it later would
  // race the write this component just made.
  const rememberedSelection = useRef(loadSelection());
  const restoredSelection = useRef(false);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Width owns composition. A fine pointer may change desktop affordances, but
  // it must not turn a compact layout back into two side-by-side columns.
  //
  // It does NOT own whether hovering works. Those are separate facts -- one about the window,
  // one about the input device -- and conflating them meant a 480pt Agents window on a Mac was
  // handed the touch story and stopped responding to the mouse it still had. Width decides
  // whether the sidebar can sit beside the content; the pointer decides whether pointing at the
  // trigger is enough to reveal it.
  const usesModalSidebar = compact;
  const sidebarPinned = !usesModalSidebar && sidebarPreferences.open;
  const drawerOpen = usesModalSidebar && sidebarPreferences.open;
  // The open session's controls render into the header through this node, and its background-tasks
  // panel into the one beside the main column, so neither costs the session a band of its own.
  // Held in state, not refs, because the view has to re-render once the nodes exist.
  const [threadControlsHost, setThreadControlsHost] = useState<HTMLDivElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLDivElement | null>(null);
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

  // Incremented to re-run the subscription below after a failure.
  //
  // A visibility subscription is one-shot: the host tears the stream down when it
  // reports an error, so without this the first failure was permanent. That is how
  // a restored Agents window that came up one second before its sidecar sat on
  // "agent feed is not ready" for a whole session. The host now waits for a
  // sidecar that is starting, which covers the launch race; this covers what is
  // left -- an outage longer than that wait, or a sidecar that dies and restarts
  // while the window is open.
  //
  // Only ever increments. The consecutive-failure count that sets the delay lives
  // in a ref instead, because resetting it on success would be a state change in
  // this effect's own dependencies -- which tears down the subscription that just
  // succeeded and re-subscribes, leaving the viewer back on "Loading".
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const consecutiveFailures = useRef(0);
  // Whether this surface has ever been handed an inventory, which is what tells a
  // reopened stream apart from a first one.
  const deliveredInventory = useRef(false);

  useEffect(() => {
    // Not on every resubscribe: expanding a project reopens this stream, and a sidebar
    // that flipped back to "Loading projects" each time a row was unfolded would be
    // reporting the transport's business as the reader's.
    if (!deliveredInventory.current) setLoadingLayer(true);
    setLayerError(null);
    setRetrying(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onError = (reason: string) => {
      deliveredInventory.current = false;
      setLayerError(reason);
      setLoadingLayer(false);
      setRetrying(true);
      const delay = retryDelayMs(consecutiveFailures.current);
      consecutiveFailures.current += 1;
      timer = setTimeout(() => setRetryNonce((n) => n + 1), delay);
    };
    const onLoaded = () => {
      deliveredInventory.current = true;
      setLoadingLayer(false);
      setRetrying(false);
      consecutiveFailures.current = 0;
    };
    const stop = feed.subscribeInventory(subscribedProjectPaths, {
      onProjects: (snapshot) => {
        setProjects(snapshot);
        onLoaded();
      },
      onSessions: (projectPath, sessions) => {
        setSessionsByProject((current) => new Map(current).set(projectPath, sessions));
      },
    }, onError);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    };
  }, [feed, retryNonce, subscribedProjectPaths]);

  useEffect(() => {
    if (projects.length === 0) return;
    if (!initializedProjectExpansion.current) {
      initializedProjectExpansion.current = true;
      // The remembered project, when it is still there, because a collapsed project's sessions
      // are not on the inventory stream at all -- so without expanding it first there is nothing
      // for the restore below to match against. Falls back to the first project, as before.
      const remembered = rememberedSelection.current?.projectPath;
      const openAt = remembered && projects.some((project) => project.projectPath === remembered)
        ? remembered
        : projects[0]!.projectPath;
      setExpandedProjectPaths(new Set([openAt]));
      return;
    }
    const currentPaths = new Set(projects.map((project) => project.projectPath));
    setExpandedProjectPaths((current) => {
      const next = new Set([...current].filter((path) => currentPaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [projects]);

  // A directory that is neither expanded nor open in a Bot session picker is no longer
  // on the stream, so keeping it would be keeping a copy that nothing refreshes.
  useEffect(() => {
    const subscribed = new Set(subscribedProjectPaths);
    setSessionsByProject((current) => {
      const next = new Map(
        [...current].filter(([projectPath]) => subscribed.has(projectPath)),
      );
      return next.size === current.size ? current : next;
    });
  }, [subscribedProjectPaths]);

  useEffect(() => () => {
    if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
  }, []);


  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarPreferences((current) => {
      if (current.open === open) return current;
      const next = { ...current, open };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  const previewSidebarWidth = useCallback((width: number) => {
    setSidebarPreferences((current) =>
      current.width === width ? current : { ...current, width },
    );
  }, []);

  const commitSidebarWidth = useCallback((width: number) => {
    setSidebarPreferences((current) => {
      const next = current.width === width ? current : { ...current, width };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  const toggleProject = useCallback((projectPath: string) => {
    setExpandedProjectPaths((current) => {
      const next = new Set(current);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current === null) return;
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }, []);

  const revealSidebarOnHover = useCallback(() => {
    cancelHoverClose();
    // Not gated on width: see `usesModalSidebar`. The two surfaces it IS gated on are the ones
    // that already show the same list -- the pinned rail and the modal drawer -- because a
    // transient copy layered over either of them is two navigations for one pointer.
    if (hoverCapable && !sidebarPinned && !drawerOpen) setHoverPreviewOpen(true);
  }, [cancelHoverClose, drawerOpen, hoverCapable, sidebarPinned]);

  const hideSidebarAfterHover = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null;
      setHoverPreviewOpen(false);
    }, 120);
  }, [cancelHoverClose]);

  /**
   * The trigger's press, at either width.
   *
   * Hover peeks; pressing commits to the surface the width allows -- the pinned rail when there
   * is room beside the content, the modal drawer that traps focus and answers Escape when there
   * is not. One callback because the choice is already made downstream by `usesModalSidebar`;
   * `sidebarPreferences.open` means the same thing to both. The peek is dropped first so the two
   * never stack.
   */
  const openSidebar = useCallback(() => {
    cancelHoverClose();
    setHoverPreviewOpen(false);
    setSidebarOpen(true);
  }, [cancelHoverClose, setSidebarOpen]);

  const dismissHoverPreview = useCallback(() => {
    cancelHoverClose();
    setHoverPreviewOpen(false);
    globalThis.requestAnimationFrame?.(() => drawerTriggerRef.current?.focus());
  }, [cancelHoverClose]);

  const closePinnedSidebar = useCallback(() => {
    setSidebarOpen(false);
    globalThis.requestAnimationFrame?.(() => drawerTriggerRef.current?.focus());
  }, [setSidebarOpen]);

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
   * A session forked from another, and the pane it runs in.
   *
   * Held here rather than in the canvas because it takes over `main`, and because the fork's own
   * identity has to outlive the row that started it: the source session can be detached from its
   * Bot while its fork is still open.
   *
   * `forkId` is minted here, once, and never derived from `sessionId` -- forking one session twice
   * has to give two panes, and a pane named after the source would give the second fork the
   * first's terminal.
   */
  const [forkedSession, setForkedSession] = useState<
    { source: "claude"; sessionId: string; forkId: string; title: string } | null
  >(null);
  // The fork's pane renders its own errors in its footer, so there is nothing for the shell to do
  // with its state. Stable so a re-render of the shell never restarts the pane.
  const noteForkTerminalState = useCallback(() => {}, []);
  const forkSession = useCallback((session: SessionSummary) => {
    if (session.source !== "claude") return;
    setForkedSession({
      source: "claude",
      sessionId: session.sessionId,
      forkId: crypto.randomUUID(),
      title: session.title || session.sessionId,
    });
  }, []);

  const openBotSessionPicker = useCallback((bot: BotView) => {
    setBotSessionPickerId(bot.botId);
    setHoverPreviewOpen(false);
  }, []);

  /**
   * Choosing Canvas on a phone closes the drawer that was used to choose it.
   *
   * Sessions and Bots put their content INSIDE the drawer, so it stays open and the reader keeps
   * picking. The canvas is the main panel, so leaving the drawer up would cover the only thing
   * the tab was pressed for with a panel that has almost nothing on it.
   */
  const changeSidebarMode = useCallback((mode: AgentSidebarMode) => {
    setSidebarMode(mode);
    if (mode === "canvas") {
      setHoverPreviewOpen(false);
      if (usesModalSidebar) setSidebarOpen(false);
    }
  }, [setSidebarOpen, usesModalSidebar]);

  const createBot = useCallback(async (command: Omit<AddBotCommand, "requestId">) => {
    await feed.createBot(command);
    setBotCreatorOpen(false);
  }, [feed]);

  const attachBotSessions = useCallback(async (bot: BotView, sessionRefs: BotSessionRef[]) => {
    await feed.attachBotSessions(bot.botId, { sessionRefs });
    setBotSessionPickerId(null);
  }, [feed]);

  /**
   * Drops one session from a Bot's projection.
   *
   * Nothing is set here on success: the Bot stream publishes a new snapshot and the row leaves on
   * its own, which is also what happens when the same Bot is edited from another surface. A
   * failure surfaces on the same band the thread's own command errors use, because a removal that
   * silently did nothing is indistinguishable from one that worked.
   */
  const detachBotSession = useCallback((bot: BotView, ref: BotSessionRef) => {
    // A missing reference has no summary to take a title from, which is exactly the row this has
    // to work on, so the id stands in.
    const label = bot.sessions
      .find((session) => session.source === ref.source && session.sessionId === ref.sessionId)
      ?.title || ref.sessionId;
    // Rebuilt field by field rather than forwarded. A `SessionSummary` structurally satisfies
    // `BotSessionRef`, so an attached row hands this its whole summary -- capabilities, title,
    // timestamps -- and passing it straight on would put all of it on the wire.
    const target: BotSessionRef = { source: ref.source, sessionId: ref.sessionId };
    // Cleared as the next removal starts rather than by the open session's own commands: the
    // failure belongs to the Bot edit, so it should outlive a send and not outlive another edit.
    setBotCommandError(null);
    void feed
      .detachBotSessions(bot.botId, { sessionRefs: [target] })
      .catch((error: unknown) => {
        setBotCommandError(
          `Could not remove ${label} from ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, [feed]);

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
    const remembered = rememberedSelection.current;
    if (!remembered) return;
    const project = projects.find((entry) => entry.projectPath === remembered.projectPath);
    const session = sessionsByProject.get(remembered.projectPath)
      ?.find((entry) => entry.sessionId === remembered.sessionId && entry.source === remembered.source);
    if (!project || !session) return;
    restoredSelection.current = true;
    openSession(project, session);
  }, [projects, sessionsByProject, selectedThread, openSession]);

  const createPiSession = useCallback(async (project: ProjectSummary) => {
    if (creatingProjectPath) return;
    setCreatingProjectPath(project.projectPath);
    setCreationErrors((current) => {
      const next = new Map(current);
      next.delete(project.projectPath);
      return next;
    });
    try {
      const created = await feed.createSession(project.projectPath, "pi");
      // Everything but the source comes from the descriptor, because the sidecar decides the
      // title, timestamps, and capabilities. The source is the one we asked for: the descriptor
      // widens it to a bare string so a backend can register an identifier neither side's build
      // knows, and this call site is not that case.
      setSelectedBotId(null);
      openSession(project, {
        sessionId: created.sessionId,
        source: "pi",
        title: created.title,
        lastEventAt: created.lastEventAt,
        activity: created.activity,
        capabilities: created.capabilities,
      });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      setCreationErrors((current) => new Map(current).set(project.projectPath, message));
    } finally {
      setCreatingProjectPath(null);
    }
  }, [feed, creatingProjectPath, openSession]);

  // One subscription for all three sidebar mounts. Owned here rather than inside the sidebar so
  // the pinned rail, the hover preview, and the phone drawer share one stream instead of opening
  // one each; only two of them are ever mounted at once, but the report should not be fetched
  // twice when they are.
  const sidebarProps = {
    mode: sidebarMode,
    onModeChange: changeSidebarMode,
    usage,
    park,
    projects,
    sessionsByProject,
    loading: loadingLayer,
    error: layerError,
    retrying,
    selectedProjectPath: selectedThread?.project.projectPath ?? null,
    selectedSessionKey: selectedThread
      ? `${selectedThread.session.source}:${selectedThread.session.sessionId}`
      : null,
    creatingProjectPath,
    creationErrors,
    expandedProjectPaths,
    onToggleProject: toggleProject,
    onSelectSession: openCatalogSession,
    onCreatePiSession: (project: ProjectSummary) => void createPiSession(project),
    bots: botsState.bots,
    botsLoading: botsState.loading,
    botsError: botsState.error,
    selectedBotId,
    onSelectBotSession: openBotSession,
    onAddBotSession: openBotSessionPicker,
    onDetachBotSession: detachBotSession,
    onAddBot: () => {
      setBotCreatorOpen(true);
      setHoverPreviewOpen(false);
    },
  };

  return (
    <DataSourceProvider source={feed}>
      {/* The horizontal safe area is spent here, once, because everything that touches a side edge
          is inside: the pinned sidebar, the header, the transcript, the composer. It is zero in
          portrait and on the Mac; it is the notch in landscape, which the shell hands the page
          rather than reserving (see index.html's `viewport-fit=cover`). The drawer is the one
          surface this cannot reach -- it renders in the top layer, outside this tree, and pays its
          own. */}
      <div className={`relative flex ${fill ? "h-full" : "h-dvh"} min-w-0 bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-foreground`}>
        <FontSizeRoot />
        <BotCreatorDialog
          open={botCreatorOpen}
          projects={projects}
          bots={botsState.bots}
          inventoryLoading={loadingLayer}
          onClose={() => setBotCreatorOpen(false)}
          onCreate={createBot}
        />
        <BotSessionPickerDialog
          open={botSessionPicker !== null}
          bot={botSessionPicker}
          sessions={botSessionPicker ? sessionsByProject.get(botSessionPicker.environment.path) : undefined}
          onClose={() => setBotSessionPickerId(null)}
          onAttach={attachBotSessions}
        />
        {usesModalSidebar ? (
          <AgentSidebarDialog
            {...sidebarProps}
            open={drawerOpen}
            triggerRef={drawerTriggerRef}
            onRequestClose={() => setSidebarOpen(false)}
          />
        ) : null}
        {sidebarPinned ? (
          <ResizableSidebar
            width={sidebarPreferences.width}
            onWidthChange={previewSidebarWidth}
            onWidthCommit={commitSidebarWidth}
          >
            <AgentSidebar
              {...sidebarProps}
              onClose={closePinnedSidebar}
              ownsWindowTitlebar
            />
          </ResizableSidebar>
        ) : null}
        {hoverCapable && !sidebarPinned && !drawerOpen && hoverPreviewOpen ? (
          <HoverSidebarPreview
            width={sidebarPreferences.width}
            onPointerEnter={cancelHoverClose}
            onPointerLeave={hideSidebarAfterHover}
            onDismiss={dismissHoverPreview}
          >
            <AgentSidebar {...sidebarProps} ownsWindowTitlebar />
          </HoverSidebarPreview>
        ) : null}

        {/* The bottom safe area is spent here rather than in whichever band happens to be last,
            because that band varies -- composer, extension notice, terminal notice, or nothing at
            all on the empty state -- and an inset owned by four components drifts. `bg-card` is
            what shows through in the strip it holds back, so the band above it reads as reaching
            the physical edge instead of floating above a gap; `main` therefore states its own
            background rather than inheriting this one. */}
        <div className="flex min-w-0 flex-1 flex-col bg-card pb-[env(safe-area-inset-bottom)]">
          <header
            data-window-drag
            className={`flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5${
              sidebarPinned ? "" : " agent-window-titlebar-main-leading"
            }`}
          >
            {!sidebarPinned ? (
              <button
                ref={drawerTriggerRef}
                type="button"
                onClick={openSidebar}
                onPointerEnter={hoverCapable ? revealSidebarOnHover : undefined}
                onPointerLeave={hoverCapable ? hideSidebarAfterHover : undefined}
                aria-label={usesModalSidebar ? "Open agent navigation" : "Pin agent sidebar"}
                aria-expanded={drawerOpen || hoverPreviewOpen}
                title={usesModalSidebar ? "Open agent navigation" : "Pin agent sidebar"}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 active:bg-muted/70"
              >
                <PanelLeft className="size-5" aria-hidden />
            </button>
            ) : null}
            <h1 className="min-w-0 flex-1 truncate px-1 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold leading-none text-foreground">
              {forkedSession
                ? `Fork of ${forkedSession.title}`
                : sidebarMode === "canvas"
                ? "Canvas"
                : sidebarMode === "bots"
                  ? selectedBotName || "Bots"
                  : displayedThread?.session.title || displayedThread?.session.sessionId || "Agent Feed"}
            </h1>
            {/* The open session's whole control strip, portalled in by `SessionView`. The gap is
                this node's rather than the header's because the strip's own members used to be
                the header's children and spaced by it. */}
            <div ref={setThreadControlsHost} className="flex shrink-0 items-center gap-1" />
          </header>

          {/* One scroller per surface, and the session owns its own: `SessionView` is a flex
              column that fills whatever box it is given, so the transcript inside it scrolls
              against a height this shell decides. */}
          <main className="min-h-0 flex-1 overflow-hidden bg-background">
            {forkedSession ? (
              <ForkedSessionView
                title={forkedSession.title}
                onClose={() => setForkedSession(null)}
              />
            ) : displayedThread ? (
              // Keyed on the session, which is what resets everything the view owns: switching
              // threads replaces it rather than clearing a dozen pieces of state by hand.
              <SessionView
                key={`${displayedThread.session.source}:${displayedThread.session.sessionId}`}
                feed={feed}
                host={host}
                projectPath={displayedThread.project.projectPath}
                session={displayedThread.session}
                eventMode={eventMode}
                onToggleEventMode={toggleEventMode}
                showCacheHits={showCacheHits}
                onToggleCacheHits={toggleCacheHits}
                controlsHost={threadControlsHost}
                windowComposers={windowComposers}
                compact={compact}
                tasksHost={tasksHost}
                externalError={botCommandError}
              />
            ) : sidebarMode === "canvas" ? (
              <BotCanvas
                bots={botsState.bots}
                loading={botsState.loading}
                error={botsState.error}
                mode={eventMode}
                onAddSession={openBotSessionPicker}
                onForkSession={forkSession}
                onDetachSession={detachBotSession}
                onAddBot={() => setBotCreatorOpen(true)}
              />
            ) : sidebarMode === "sessions" ? (
              <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
                Select a session from Sessions
              </div>
            ) : null}
          </main>
          {forkedSession ? (
            <AgentTerminalPane
              key={forkedSession.forkId}
              feed={feed}
              context={{
                kind: "session-fork",
                source: forkedSession.source,
                sessionId: forkedSession.sessionId,
                forkId: forkedSession.forkId,
              }}
              onState={noteForkTerminalState}
              layout="band"
            />
          ) : null}
        </div>
        {/* Where the open session's background-tasks panel lands: outside the main column, so on
            the Mac it is a real column beside the thread rather than a band inside it, and it
            positions against this root rather than against whatever box the session is in. On a
            phone it renders as a sheet over everything. `contents` keeps this node itself out of
            the layout, so the panel is the flex child it was before it was portalled. */}
        <div ref={setTasksHost} className="contents" />
      </div>
    </DataSourceProvider>
  );
}

/**
 * What a fork shows before it has said anything.
 *
 * Empty on purpose, and not a loading state: a forked session has no transcript to read because
 * the CLI writes none until its first turn. Measured -- resuming a fork loaded 255k tokens of
 * context and created no file at all; the file appeared only after one message. So the terminal
 * below is the whole session until then, and this says so rather than spinning on a transcript
 * that is not coming.
 */
function ForkedSessionView({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
      <GitFork className="size-5" aria-hidden />
      <p className="max-w-prose">
        Forked from <span className="font-medium text-foreground">{title}</span>. Its transcript
        appears here once you send the first message in the terminal below.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="min-h-9 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
      >
        Close fork
      </button>
    </div>
  );
}

