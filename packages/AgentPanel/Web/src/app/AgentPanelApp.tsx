import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { PanelLeft } from "lucide-react";
import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
  ProjectSummary,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type {
  HostActionsClient,
} from "@/features/activity-feed/data-source/HostActionsClient";
import { sidecarWindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { FontSizeRoot } from "@/features/activity-feed/reading-preferences/fontStore";
import { useDesktopPark } from "@/features/desktop-park/useDesktopPark";
import { useUsage } from "@/features/usage/useUsage";
import {
  AgentSidebar,
  AgentSidebarDialog,
  type AgentSidebarMode,
} from "@/features/sidebar/AgentSidebar";
import {
  HoverSidebarPreview,
  ResizableSidebar,
} from "@/features/sidebar/SidebarPresentation";
import { useSidebarChrome } from "@/app/shell-state/useSidebarChrome";
import { useProjectInventory } from "@/app/shell-state/useProjectInventory";
import { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import { useThreadSelection } from "@/app/shell-state/useThreadSelection";
import { usePiSessionCreation } from "@/app/shell-state/usePiSessionCreation";
import { AppDialogs } from "@/app/AppDialogs";
import { sidebarProps } from "@/app/shell-state/sidebarProps";
import { loadSelection, storeSelection } from "@/features/sidebar/selectionStore";
import { useBots } from "@/features/bots/useBots";
import { BotCanvas, type BotCommandError } from "@/features/bots/BotCanvas";
import { botCanvasHues } from "@/features/bots/botSurface";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { ForkedSessionView } from "@/app/ForkedSessionView";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";




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
  const chrome = useSidebarChrome();
  const botsState = useBots(feed);
  const roster = useCanvasRoster(botsState);
  const commands = useBotCommands(
    feed,
    { setDetachedBotIds: roster.setDetachedBotIds, setDetachedSessionKeys: roster.setDetachedSessionKeys, setCanvasOpenKeys: roster.setCanvasOpenKeys },
    chrome.setHoverPreviewOpen,
  );

  const botSessionPicker = commands.botSessionPickerId
    ? botsState.bots.find((bot) => bot.botId === commands.botSessionPickerId) ?? null
    : null;
  /**
   * What the open thread does with a dropped image, published up from the session inside it.
   *
   * Null while no session is displayed, and null while the displayed one has no composer to paste
   * into. The column below is the drop target either way: refusing is an act here, because a box
   * with no handler hands the file to the browser rather than declining it.
   */
  const [threadAcceptFiles, setThreadAcceptFiles] = useState<
    ((files: readonly File[]) => void) | null
  >(null);
  // Wrapped, because `setThreadAcceptFiles` would take the accepting function as an updater and
  // call it with the previous value instead of storing it.
  const takeThreadAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setThreadAcceptFiles(() => accept),
    [],
  );
  const threadDrop = useFileDropTarget<HTMLDivElement>(threadAcceptFiles);
  /**
   * Every Bot's colour, derived from the WHOLE roster rather than from the cards on the canvas.
   *
   * Computed here for the same reason `detachedCount` is: the canvas is handed the Bots it shows,
   * and a colour ranked over that subset would repaint the whole strip whenever a reader took one
   * off it. The full list is what makes a Bot's colour its own.
   */
  const botHues = useMemo(() => botCanvasHues(botsState.bots), [botsState.bots]);
  // Read once, at mount. Storage is written on every selection, so re-reading it later would
  // race the write this component just made.
  /**
   * The directories the inventory must watch beyond the ones the reader expanded.
   *
   * A Bot session picker needs its Bot's project on the stream to list anything at all.
   */
  const extraProjectPaths = useMemo(() => {
    const paths: string[] = [];
    if (botSessionPicker) paths.push(botSessionPicker.environment.path);
    // A started session's own directory, which is not always its Bot's: a session in a worktree
    // is listed under the worktree. Subscribed so the canvas sees it become a real session and
    // stops rendering the placeholder card, not so it can be attached -- the Bot did that when it
    // started it.
    for (const started of commands.newSessions) paths.push(started.projectPath);
    return paths;
  }, [botSessionPicker, commands.newSessions]);
  // Read once, at mount. Storage is written on every selection, so re-reading it later would
  // race the write this component just made.
  const rememberedSelection = useRef(loadSelection());
  const inventory = useProjectInventory(feed, extraProjectPaths, rememberedSelection.current?.projectPath);
  const thread = useThreadSelection({
    projects: inventory.projects,
    sessionsByProject: inventory.sessionsByProject,
    rememberedSelection: rememberedSelection.current,
    setBotCommandError: commands.setBotCommandError,
    setHoverPreviewOpen: chrome.setHoverPreviewOpen,
    setSidebarOpen: chrome.setSidebarOpen,
    usesModalSidebar: chrome.usesModalSidebar,
  });
  const { creatingProjectPath, creationErrors, createPiSession } = usePiSessionCreation(
    feed,
    thread.openSession,
    thread.setSelectedBotId,
  );
  // A catalog selection survives a trip through Bots. A Bot selection opens that same underlying
  // session, but entering Bots from Sessions still presents an empty middle panel rather than
  // relabelling the current session as a Bot.
  // Canvas has no single thread by construction: it shows the whole roster, so `main` renders the
  // canvas instead of a transcript. Everything below the transcript -- composer, summary band,
  // tasks chip, extension surface -- is already gated on this, so they stand down without a
  // condition of their own.
  const displayedThread = chrome.sidebarMode === "canvas"
    ? null
    : chrome.sidebarMode === "sessions"
      ? thread.selectedThread
      : thread.selectedBotId ? thread.selectedThread : null;
  const selectedBotName = thread.selectedBotId
    ? botsState.bots.find((bot) => bot.botId === thread.selectedBotId)?.name
    : undefined;
  /**
   * The names already standing in the project a fork would join, which is what its number counts
   * past. Taken from the sidebar's own list rather than re-read, so the proposal agrees with the
   * rows the reader can see -- a second reading could be a moment ahead of them and propose a
   * number for a fork that is not on screen yet.
   */
  /**
   * The names already standing where a new session would be started, which is what its number
   * counts past. The catalog's titles plus the ones this panel has started and the catalog has not
   * heard of yet -- without the second half, two presses in one minute propose the same name, and
   * `-n` would then address neither of them.
   */
  const sessionTitlesInBot = useMemo(
    () => botSessionPicker
      ? [
        ...(inventory.sessionsByProject.get(botSessionPicker.environment.path) ?? [])
          .map((session) => session.title),
        ...commands.newSessions
          .filter((started) => started.botId === botSessionPicker.botId)
          .map((started) => started.title),
      ]
      : [],
    [botSessionPicker, commands.newSessions, inventory.sessionsByProject],
  );
  const forkTitlesInProject = useMemo(
    () => commands.forkRequest
      ? (inventory.sessionsByProject.get(commands.forkRequest.projectPath) ?? []).map((session) => session.title)
      : [],
    [commands.forkRequest, inventory.sessionsByProject],
  );
  // The open session's controls render into the header through this node, and its background-tasks
  // panel into the one beside the main column, so neither costs the session a band of its own.
  // Held in state, not refs, because the view has to re-render once the nodes exist.
  const [threadControlsHost, setThreadControlsHost] = useState<HTMLDivElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLDivElement | null>(null);













  /**
   * Everything a session needs that is not the session: built once and handed to whichever surface
   * is showing one. The thread view and the Bot canvas both render `SessionView`, and neither is
   * the place to decide how a window composer is built or where a tasks panel lands.
   */
  const sessionViewContext: SessionViewContext = {
    feed,
    host,
    eventMode: thread.eventMode,
    onToggleEventMode: thread.toggleEventMode,
    showCacheHits: thread.showCacheHits,
    onToggleCacheHits: thread.toggleCacheHits,
    windowComposers,
    compact: chrome.compact,
    tasksHost,
    onForkFromMessage: commands.forkFromMessage,
  };

  // One subscription for all three sidebar mounts. Owned here rather than inside the sidebar so
  // the pinned rail, the hover preview, and the phone drawer share one stream instead of opening
  // one each; only two of them are ever mounted at once, but the report should not be fetched
  // twice when they are.
  const sidebar = sidebarProps({
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
  });

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
        <AppDialogs
          attachBotSessions={commands.attachBotSessions}
          botCreatorOpen={commands.botCreatorOpen}
          bots={botsState.bots}
          botSessionPicker={botSessionPicker}
          createBot={commands.createBot}
          forkRequest={commands.forkRequest}
          forkTitlesInProject={forkTitlesInProject}
          inventoryLoading={inventory.loadingLayer}
          projects={inventory.projects}
          renameSession={commands.renameSession}
          renamingSession={commands.renamingSession}
          sessionsByProject={inventory.sessionsByProject}
          sessionTitlesInBot={sessionTitlesInBot}
          setBotCreatorOpen={commands.setBotCreatorOpen}
          setBotSessionPickerId={commands.setBotSessionPickerId}
          setForkRequest={commands.setForkRequest}
          setRenamingSession={commands.setRenamingSession}
          startFork={commands.startFork}
          startNewSession={commands.startNewSession}
        />
        {chrome.usesModalSidebar ? (
          <AgentSidebarDialog
            {...sidebar}
            open={chrome.drawerOpen}
            triggerRef={chrome.drawerTriggerRef}
            onRequestClose={() => chrome.setSidebarOpen(false)}
          />
        ) : null}
        {chrome.sidebarPinned ? (
          <ResizableSidebar
            width={chrome.sidebarPreferences.width}
            onWidthChange={chrome.previewSidebarWidth}
            onWidthCommit={chrome.commitSidebarWidth}
          >
            <AgentSidebar
              {...sidebar}
              onClose={chrome.closePinnedSidebar}
              ownsWindowTitlebar
            />
          </ResizableSidebar>
        ) : null}
        {chrome.hoverCapable && !chrome.sidebarPinned && !chrome.drawerOpen && chrome.hoverPreviewOpen ? (
          <HoverSidebarPreview
            width={chrome.sidebarPreferences.width}
            onPointerEnter={chrome.cancelHoverClose}
            onPointerLeave={chrome.hideSidebarAfterHover}
            onDismiss={chrome.dismissHoverPreview}
          >
            <AgentSidebar {...sidebar} ownsWindowTitlebar />
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
              chrome.sidebarPinned ? "" : " agent-window-titlebar-main-leading"
            }`}
          >
            {!chrome.sidebarPinned ? (
              <button
                ref={chrome.drawerTriggerRef}
                type="button"
                onClick={chrome.openSidebar}
                onPointerEnter={chrome.hoverCapable ? chrome.revealSidebarOnHover : undefined}
                onPointerLeave={chrome.hoverCapable ? chrome.hideSidebarAfterHover : undefined}
                aria-label={chrome.usesModalSidebar ? "Open agent navigation" : "Pin agent sidebar"}
                aria-expanded={chrome.drawerOpen || chrome.hoverPreviewOpen}
                title={chrome.usesModalSidebar ? "Open agent navigation" : "Pin agent sidebar"}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 active:bg-muted/70"
              >
                <PanelLeft className="size-5" aria-hidden />
            </button>
            ) : null}
            <h1 className="min-w-0 flex-1 truncate px-1 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold leading-none text-foreground">
              {commands.forkedSession
                ? commands.forkedSession.title
                : chrome.sidebarMode === "canvas"
                ? "Canvas"
                : chrome.sidebarMode === "bots"
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
            {commands.forkedSession ? (
              <ForkedSessionView
                title={commands.forkedSession.sourceTitle}
                rewindFailed={commands.forkedSession.rewindFailed}
                onClose={() => commands.setForkedSession(null)}
              />
            ) : displayedThread ? (
              // The box a reader aims a file at here, the way a card is on the canvas: the session
              // publishes what it can take and whichever surface owns the box installs it. Wrapped
              // rather than put on `main`, which is shared with the canvas -- where every card is
              // its own target and a drag over one bubbles up to here, lighting both.
              <div className="relative h-full" {...threadDrop.dropProps}>
                {/* Keyed on the session, which is what resets everything the view owns: switching
                    threads replaces it rather than clearing a dozen pieces of state by hand. */}
                <SessionView
                  key={`${displayedThread.session.source}:${displayedThread.session.sessionId}`}
                  {...sessionViewContext}
                  projectPath={displayedThread.project.projectPath}
                  session={displayedThread.session}
                  controlsHost={threadControlsHost}
                  onAcceptFiles={takeThreadAcceptFiles}
                  // The thread view shows one session, so it takes a failure about that session and
                  // one about no session at all. Note the composer band outranks this caption for
                  // every Claude and Codex session, which is why the canvas puts it on the card
                  // instead; here there is nowhere else to put it.
                  externalError={commands.botCommandError
                      && (commands.botCommandError.session === null
                        || commands.botCommandError.session
                          === `${displayedThread.session.source}:${displayedThread.session.sessionId}`)
                    ? commands.botCommandError.message
                    : null}
                />
                <FileDropOverlay
                  dragging={threadDrop.dragging}
                  refusal={threadAcceptFiles === null
                    ? "This session has no composer to drop into"
                    : null}
                />
              </div>
            ) : chrome.sidebarMode === "canvas" ? (
              <BotCanvas
                bots={roster.canvasBots}
                hues={botHues}
                loading={botsState.loading}
                error={botsState.error}
                sessionContext={sessionViewContext}
                botError={commands.botCommandError}
                onAddSession={commands.openBotSessionPicker}
                onForkSession={commands.forkSession}
                onForkFromLastMessage={commands.forkFromLastMessage}
                onRenameSession={commands.setRenamingSession}
                onDetachSession={commands.detachBotSession}
                onRemoveSessionFromCanvas={roster.removeSessionFromCanvas}
                onDetachBot={roster.toggleBotOnCanvas}
                detachedCount={botsState.bots.length - roster.canvasBots.length}
                detachedSessionKeys={roster.detachedSessionKeys}
                openKeys={roster.canvasOpenKeys}
                onToggleSession={roster.toggleCanvasSession}
                onAddBot={() => commands.setBotCreatorOpen(true)}
                newSessions={commands.newSessions}
                onCloseNewSession={commands.closeNewSession}
              />
            ) : chrome.sidebarMode === "sessions" ? (
              <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
                Select a session from Sessions
              </div>
            ) : null}
          </main>
          {commands.forkedSession ? (
            <AgentTerminalPane
              key={commands.forkedSession.sessionId}
              feed={feed}
              // Attaching, not starting: the Bot started this fork before this pane existed, so
              // opening it twice is the same as opening it once.
              context={{ kind: "tmux", session: commands.forkedSession.tmuxSession }}
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
