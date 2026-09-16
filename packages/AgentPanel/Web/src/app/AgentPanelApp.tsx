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
import { useShellInventory } from "@/app/shell-state/useShellInventory";
import { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import { useThreadSelection } from "@/app/shell-state/useThreadSelection";
import { usePiSessionCreation } from "@/app/shell-state/usePiSessionCreation";
import { AppDialogs } from "@/app/AppDialogs";
import { sidebarProps } from "@/app/shell-state/sidebarProps";
import { storeSelection } from "@/features/sidebar/selectionStore";
import { BotCanvas, type BotCommandError } from "@/features/bots/BotCanvas";
import { botCanvasHues } from "@/features/bots/botSurface";
import type { BotMachine } from "@/features/bots/botMachines";
import { useBotMachines } from "@/app/shell-state/useBotMachines";
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
   * Every sidecar the Bot canvas reads, home first, or absent for a panel that knows of only one.
   *
   * A Bot is a directory and the sessions working in it, and that directory does not have to be on
   * this Mac: `tools/remote-sidecar.sh` runs an agent-feed sidecar on an ssh peer and the dev server
   * already proxies to it. Which peers exist is the embedder's question rather than this app's --
   * the browser shell subscribes to the dev server's live index, and the host's webview reaches one
   * sidecar through a relay and has no index to read -- so it arrives as a prop and defaults to the
   * single machine this app was built around.
   */
  machines?: readonly BotMachine[];
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


export function App({ feed, host, machines, fill = false }: Props) {
  // Which machines this shell can see, which Bots are on each, and which sidecar answers for one.
  // One hook because it is one decision made in five places; see `useBotMachines`.
  const shellMachines = useBotMachines(feed, machines);
  const botsState = shellMachines.roster;
  const windowComposers = shellMachines.composers;
  // This machine's per-day token usage, behind the sidebar's Profile section. The stream opens
  // when somebody asks for it, not on mount.
  const usage = useUsage(feed);
  // Gathering windows onto one Desktop is a machine-level capability, probed once
  // the same way usage is. Absent yabai, the menu entry stays disabled.
  const park = useDesktopPark(feed);
  const chrome = useSidebarChrome();
  // `known` as well as `settled`: a roster that is complete for the machines seen SO FAR is not a
  // roster to drop stored cards against. See `useBotMachines`.
  const roster = useCanvasRoster({
    bots: botsState.bots,
    settled: botsState.settled && shellMachines.known,
  });
  const commands = useBotCommands(
    shellMachines.feeds,
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
  /**
   * The machine the open session picker's Bot is on, or null when it is this one.
   *
   * The picker asks a DIRECTORY which sessions are in it, and a directory is a question only its
   * own machine can answer. Before this it was always asked here, so a peer Bot's picker sat on
   * "Loading sessions from this directory" for good: the Mac's inventory stream accepted the path,
   * found no project, and simply never sent a sessions message for it. Measured, not reasoned --
   * it is what the first oracle Bot's picker did.
   */
  const { inventory, dialogSessionsByProject, rememberedSelection } = useShellInventory({
    feed,
    machineOf: botsState.machineOf,
    picker: botSessionPicker
      ? { botId: botSessionPicker.botId, projectPath: botSessionPicker.environment.path }
      : null,
    startedSessions: commands.newSessions,
  });
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
   * The canvas with no bar over it.
   *
   * That bar exists to name the session under it and to carry the session's controls, and the
   * canvas has neither: it is every Bot at once, and the cards carry their own controls because
   * each one holds a session of its own. What is left is the word "Canvas" written directly above
   * the pinned sidebar's selected Canvas tab, and 44px of a strip whose cards are measured in rows.
   *
   * Gated on the sidebar being PINNED rather than dropped outright, because the bar is not only a
   * title: its one button is the way back to a sidebar that is away, and on a phone with the drawer
   * closed it is also the only thing on screen that says where the reader is. Both of those are
   * exactly what a pinned sidebar is already doing two inches to the left.
   */
  const headerlessCanvas = chrome.sidebarMode === "canvas"
    && chrome.sidebarPinned
    && !commands.forkedSession;
  /**
   * The names already standing where a new session would be started, which is what its number
   * counts past. The catalog's titles plus the ones this panel has started and the catalog has not
   * heard of yet -- without the second half, two presses in one minute propose the same name, and
   * `-n` would then address neither of them.
   */
  const sessionTitlesInBot = useMemo(
    () => botSessionPicker
      ? [
        ...(dialogSessionsByProject.get(botSessionPicker.environment.path) ?? [])
          .map((session) => session.title),
        ...commands.newSessions
          .filter((started) => started.botId === botSessionPicker.botId)
          .map((started) => started.title),
      ]
      : [],
    [botSessionPicker, commands.newSessions, dialogSessionsByProject],
  );
  /**
   * The names already standing in the project a fork would join, which is what its number counts
   * past. Taken from the sidebar's own list rather than re-read, so the proposal agrees with the
   * rows the reader can see -- a second reading could be a moment ahead of them and propose a
   * number for a fork that is not on screen yet.
   */
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
    machines: shellMachines,
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
          machines={shellMachines.all}
          machineOfBot={botsState.machineOf}
          forkTitlesInProject={forkTitlesInProject}
          inventoryLoading={inventory.loadingLayer}
          projects={inventory.projects}
          renameSession={commands.renameSession}
          renamingSession={commands.renamingSession}
          sessionsByProject={dialogSessionsByProject}
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
          {headerlessCanvas ? null : (
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
          )}

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
                machines={shellMachines.chips}
                keyOfBot={shellMachines.keyOfBot}
                hiddenMachines={roster.hiddenMachines}
                machineErrors={botsState.machineErrors}
                sessionContextFor={(botId) => shellMachines.contextFor(sessionViewContext, botId)}
                botError={commands.botCommandError}
                onAddSession={commands.openBotSessionPicker}
                onForkSession={commands.forkSession}
                onForkFromLastMessage={commands.forkFromLastMessage}
                onForkFromLastCompaction={commands.forkFromLastCompaction}
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
