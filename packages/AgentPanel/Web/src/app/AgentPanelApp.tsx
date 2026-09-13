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
import { searchWithSidebarMode, sidebarModeFromSearch } from "../features/sidebar/sidebarRoute";
import { loadSelection, storeSelection } from "../features/sidebar/selectionStore";
import { useBots } from "../features/bots/useBots";
import { BotCanvas, type BotCommandError } from "../features/bots/BotCanvas";
import {
  loadCanvasOpenKeys,
  loadDetachedBotIds,
  loadDetachedSessionKeys,
  storeCanvasOpenKeys,
  storeDetachedBotIds,
  storeDetachedSessionKeys,
} from "../features/bots/botCanvasPreferences";
import { BotCreatorDialog } from "../features/bots/BotCreatorDialog";
import { botCanvasHues } from "../features/bots/botSurface";
import { SessionRenameDialog } from "../features/bots/SessionRenameDialog";
import { ForkSessionDialog } from "../features/bots/ForkSessionDialog";
import { BotSessionPickerDialog } from "../features/bots/BotSessionPickerDialog";
import type { NewBotSession } from "../features/bots/BotNewSessionCard";
import { SessionView, type SessionViewContext } from "../features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "../features/session-view/fileDropTarget";
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
  // Carries the session it is about, because the canvas shows several at once and a bare string was
  // painted on every one of them; see `BotCommandError`.
  const [botCommandError, setBotCommandError] = useState<BotCommandError | null>(null);
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
  /**
   * The sidebar's arrangement, with the address bar ahead of what was stored.
   *
   * The address is what a reload actually carries, so it wins whenever it names a view. Storage
   * answers the case it cannot -- a fresh tab typed as the bare origin -- and the address is then
   * written to match, so from the first paint there is one place to read the answer from rather
   * than two that can drift.
   */
  const [sidebarPreferences, setSidebarPreferences] = useState(() => {
    const stored = loadSidebarPreferences();
    const asked = typeof window === "undefined"
      ? null
      : sidebarModeFromSearch(window.location.search);
    return asked === null ? stored : { ...stored, mode: asked };
  });
  // One owner for every rendering of the sidebar: the pinned desktop rail, hover preview,
  // and phone drawer must never disagree about which view is selected.
  const sidebarMode = sidebarPreferences.mode;
  // Written on every change of the view rather than only on a press, so the address is right after
  // a restore from storage too. `replaceState` rather than `pushState`: choosing a view is not a
  // navigation, and making Back walk the tabs would take a reader out of the panel to leave it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sidebarModeFromSearch(window.location.search) === sidebarMode) return;
    try {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${searchWithSidebarMode(window.location.search, sidebarMode)}${window.location.hash}`,
      );
    } catch {
      // A custom-scheme container may refuse to rewrite its address; the panel does not need it to.
    }
  }, [sidebarMode]);
  const botsState = useBots(feed);
  // What the reader has taken off the canvas: whole Bots by id, then single sessions as
  // `source:sessionId`. Both live here rather than inside the canvas so the cards and the sidebar
  // roster that arranges them read one set each, and both are remembered across reloads --
  // `botCanvasPreferences` carries why that is safe now and was not before.
  const [detachedBotIds, setDetachedBotIds] = useState<ReadonlySet<string>>(loadDetachedBotIds);
  const [detachedSessionKeys, setDetachedSessionKeys] = useState<ReadonlySet<string>>(
    loadDetachedSessionKeys,
  );
  const removeSessionFromCanvas = useCallback((session: BotSessionRef) => {
    setDetachedSessionKeys((current) => new Set(current).add(`${session.source}:${session.sessionId}`));
  }, []);
  // Which sessions the canvas has open, as `source:sessionId`. Held here rather than inside the
  // canvas because the sidebar's roster opens cards too, and a picker cannot drive state that lives
  // inside the thing it is driving.
  const [canvasOpenKeys, setCanvasOpenKeys] = useState<ReadonlySet<string>>(loadCanvasOpenKeys);
  const toggleCanvasSession = useCallback((key: string) => {
    setCanvasOpenKeys((current) => {
      // A new set rather than a mutation, because React decides whether to re-render by identity.
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  // One write for every way the open cards change -- a row's own toggle, the sidebar roster opening
  // one, a Bot leaving the canvas -- rather than a call beside each of them, which is how one of
  // them ends up forgotten.
  useEffect(() => storeCanvasOpenKeys(canvasOpenKeys), [canvasOpenKeys]);
  // And one prune, because an open key is an address that nothing resolved: a key naming a session
  // no Bot holds any more opened nothing, went unnoticed for exactly that reason, and stayed in the
  // store for good. Dropped against the roster rather than on write, and only once the roster is
  // genuinely KNOWN -- `loading` goes false on a stream failure too, and pruning against the empty
  // list that leaves would forget every open card because the sidecar restarted.
  //
  // A Bot's whole reference list, not the sessions that currently resolve: a transcript the sidecar
  // cannot read this minute is still a session the reader left open, and dropping its key would
  // make a temporary absence permanent.
  //
  // An EMPTY roster prunes nothing either, and that guard is the one that was measured rather than
  // reasoned: the stream delivers a snapshot before the Bots are in it, and pruning against that
  // one wiped the store on every mount. A canvas with no Bots has nothing to open, so there is
  // nothing to win by dropping keys there and a whole canvas to lose.
  useEffect(() => {
    if (botsState.loading || botsState.error !== null || botsState.bots.length === 0) return;
    const held = new Set(
      botsState.bots.flatMap((bot) => bot.sessionRefs.map((ref) => `${ref.source}:${ref.sessionId}`)),
    );
    setCanvasOpenKeys((current) => {
      const kept = new Set([...current].filter((key) => held.has(key)));
      // Identity when nothing goes, so this neither re-renders nor rewrites the store on every
      // snapshot the stream sends.
      return kept.size === current.size ? current : kept;
    });
  }, [botsState.bots, botsState.loading, botsState.error]);
  // The same one-write rule, and these two need it more than the open keys do: each set shrinks
  // from the sidebar roster and from a real detach as well as growing from a menu, so a call beside
  // each of those is how one of them ends up forgotten.
  useEffect(() => storeDetachedBotIds(detachedBotIds), [detachedBotIds]);
  useEffect(() => storeDetachedSessionKeys(detachedSessionKeys), [detachedSessionKeys]);
  const canvasBots = botsState.bots.filter((bot) => !detachedBotIds.has(bot.botId));
  // Opens one of a Bot's sessions on the canvas rather than in place of it. Puts the Bot back on
  // the canvas first if it was off: the alternative is a click that appears to do nothing, because
  // the card it opens is not being rendered.
  const openSessionOnCanvas = useCallback((bot: BotView, session: SessionSummary) => {
    // The row in the sidebar is the only way back for a session taken off the canvas, so it puts
    // one back for the same reason it puts a detached Bot back: a click that appears to do nothing
    // is worse than a click that does slightly more than asked.
    setDetachedSessionKeys((current) => {
      const key = `${session.source}:${session.sessionId}`;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setDetachedBotIds((current) => {
      if (!current.has(bot.botId)) return current;
      const next = new Set(current);
      next.delete(bot.botId);
      return next;
    });
    // Opens rather than toggles, unlike the card's own row. The same click also puts a detached
    // Bot back, and a click that re-attaches a Bot while closing the session it was clicked for
    // means two contradictory things at once. Closing stays where the card is.
    setCanvasOpenKeys((current) => {
      const key = `${session.source}:${session.sessionId}`;
      if (current.has(key)) return current;
      return new Set(current).add(key);
    });
  }, []);
  const toggleBotOnCanvas = useCallback((bot: BotView) => {
    setDetachedBotIds((current) => {
      // A new set rather than a mutation, because React decides whether to re-render by identity.
      const next = new Set(current);
      if (!next.delete(bot.botId)) next.add(bot.botId);
      return next;
    });
  }, []);
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
  /**
   * A session forked from another, and the pane it runs in.
   *
   * Held here rather than in the canvas because it takes over `main`, and because the fork's own
   * identity has to outlive the row that started it: the source session can be detached from its
   * Bot while its fork is still open.
   *
   * Everything in it comes back from `POST /api/bots/:id/sessions` and none of it is predicted.
   * The panel used to mint the fork's id, name its pane by the sidecar's own rule, and then open a
   * terminal whose context created the session as a side effect of attaching to it -- so the page
   * held a second copy of three decisions the sidecar owns, and the fork reached its Bot only
   * after its first turn had landed. The Bot creates and attaches it now, and this is the receipt.
   */
  const [forkedSession, setForkedSession] = useState<
    {
      sessionId: string;
      title: string;
      /** The pane the Bot started it in. Taken from the Bot, never rebuilt here. */
      tmuxSession: string;
      /** What it was forked FROM, which is the one thing the empty view has to say. */
      sourceTitle: string;
    } | null
  >(null);
  /**
   * Sessions this panel has started fresh, until the catalog has heard of them.
   *
   * Held here for the same reason the fork above is, and it is the same gap: `claude` writes no
   * transcript until its first turn, and the sidecar refuses a Bot reference to a session that is
   * not in the catalog. So there is a window -- one turn long -- in which the session is running,
   * has a name, has a pane, and cannot be attached to anything. The canvas renders it from this
   * list during that window, and the effect below hands it over the moment it can.
   *
   * A list rather than one, unlike the fork, because these are cards on a canvas that already
   * holds as many as the reader opens: starting a second before the first has spoken is an
   * ordinary thing to do, and the fork's single slot would have silently replaced it.
   *
   * Not persisted, deliberately. It is a record the stream is about to own, not an arrangement of
   * the reader's -- so a reload during that window shows the Bot without the card, and the session
   * appears on it a turn later like any other. Storing it would make the panel a second source of
   * truth for which sessions exist.
   */
  const [newSessions, setNewSessions] = useState<readonly NewBotSession[]>([]);
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
  /** The session whose fork is being named, if any. Nothing is started until it is confirmed. */
  const [forkRequest, setForkRequest] = useState<
    { session: SessionSummary; botId: string; projectPath: string } | null
  >(null);
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
        ...(sessionsByProject.get(botSessionPicker.environment.path) ?? [])
          .map((session) => session.title),
        ...newSessions
          .filter((started) => started.botId === botSessionPicker.botId)
          .map((started) => started.title),
      ]
      : [],
    [botSessionPicker, newSessions, sessionsByProject],
  );
  /**
   * Every Bot's colour, derived from the WHOLE roster rather than from the cards on the canvas.
   *
   * Computed here for the same reason `detachedCount` is: the canvas is handed the Bots it shows,
   * and a colour ranked over that subset would repaint the whole strip whenever a reader took one
   * off it. The full list is what makes a Bot's colour its own.
   */
  const botHues = useMemo(() => botCanvasHues(botsState.bots), [botsState.bots]);
  const forkTitlesInProject = useMemo(
    () => forkRequest
      ? (sessionsByProject.get(forkRequest.projectPath) ?? []).map((session) => session.title)
      : [],
    [forkRequest, sessionsByProject],
  );

  // The subscription's identity, not merely its argument: expanding or collapsing a
  // project reopens the inventory stream exactly once, and re-rendering for any other
  // reason leaves the open stream alone. Joined on NUL, the one byte a POSIX path
  // cannot contain, so the round trip cannot invent or lose a path.
  const subscribedProjectKey = useMemo(() => {
    const paths = [...expandedProjectPaths];
    if (botSessionPicker) paths.push(botSessionPicker.environment.path);
    // A started session's own directory, which is not always its Bot's: a session in a worktree
    // is listed under the worktree. Subscribed so the canvas sees it become a real session and
    // stops rendering the placeholder card, not so it can be attached -- the Bot did that when it
    // started it.
    for (const started of newSessions) paths.push(started.projectPath);
    return [...new Set(paths)].sort().join("\0");
  }, [botSessionPicker, expandedProjectPaths, newSessions]);
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

  // Asks for a name rather than forking. Nothing is started here: the pane, the tmux session and
  // the `claude --fork-session` behind it all wait on the dialog being confirmed, because `-n` is
  // an argument of that command and there is no second chance to set it.
  const forkSession = useCallback((bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    setForkRequest({
      session,
      botId: bot.botId,
      projectPath: bot.environment.path,
    });
  }, []);
  const startFork = useCallback(
    async (
      request: { session: SessionSummary; botId: string; projectPath: string },
      forkTitle: string,
      brief: string,
      worktree: boolean,
    ) => {
      setForkRequest(null);
      setBotCommandError(null);
      try {
        const added = await feed.addBotSessions(request.botId, {
          launch: {
            title: forkTitle,
            from: { source: "claude", sessionId: request.session.sessionId },
            ...(brief.trim() ? { prompt: brief } : {}),
            ...(worktree ? { worktree: {} } : {}),
          },
        });
        if (!added.started) return;
        setForkedSession({
          sessionId: added.started.sessionId,
          title: added.started.title,
          tmuxSession: added.started.tmuxSession,
          sourceTitle: request.session.title || request.session.sessionId,
        });
      } catch (error) {
        // Named rather than attributed to a session: the fork does not exist, so there is no card
        // for this to land on. A fork that silently failed to start is indistinguishable from one
        // that was never asked for.
        setBotCommandError({
          session: null,
          message: `Could not fork the session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    [feed],
  );

  const startNewSession = useCallback(async (bot: BotView, title: string) => {
    setBotSessionPickerId(null);
    setBotCommandError(null);
    try {
      const added = await feed.addBotSessions(bot.botId, { launch: { title } });
      if (!added.started) return;
      const started = added.started;
      setNewSessions((current) => [
        ...current,
        {
          botId: bot.botId,
          sessionId: started.sessionId,
          title: started.title,
          projectPath: started.projectPath,
          tmuxSession: started.tmuxSession,
        },
      ]);
      setDetachedBotIds((current) => {
        if (!current.has(bot.botId)) return current;
        const next = new Set(current);
        next.delete(bot.botId);
        return next;
      });
      setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
    } catch (error) {
      setBotCommandError({
        session: null,
        message: `Could not start the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feed]);

  /** Takes a started session off the canvas. Its tmux session keeps running; see the card. */
  const closeNewSession = useCallback((sessionId: string) => {
    setNewSessions((current) => current.filter((started) => started.sessionId !== sessionId));
  }, []);

  /**
   * The session whose title is being edited, if any.
   *
   * Held by identity rather than by summary so the dialog is opened by the row that has one; the
   * new title is read back from the stream like every other change to a session, so nothing here
   * has to be updated when the rename lands.
   */
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    await feed.renameSession(session.sessionId, title);
    setRenamingSession(null);
  }, [feed]);

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
    setSidebarPreferences((current) => {
      if (current.mode === mode) return current;
      const next = { ...current, mode };
      storeSidebarPreferences(next);
      return next;
    });
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
    await feed.addBotSessions(bot.botId, { sessionRefs });
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
    // Forgotten here rather than left to expire with the panel. Hiding a card and then removing
    // the session from the Bot are two different acts, and a leftover key would meet the session
    // again if it were ever attached back -- as an invisible row, on a card that never said so.
    setDetachedSessionKeys((current) => {
      const key = `${target.source}:${target.sessionId}`;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    void feed
      .detachBotSessions(bot.botId, { sessionRefs: [target] })
      .catch((error: unknown) => {
        // Named: the detach failed, so the session is still on the canvas and its own card is
        // what says the removal did not happen.
        setBotCommandError({
          session: `${target.source}:${target.sessionId}`,
          message: `Could not remove ${label} from ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
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

  /**
   * Everything a session needs that is not the session: built once and handed to whichever surface
   * is showing one. The thread view and the Bot canvas both render `SessionView`, and neither is
   * the place to decide how a window composer is built or where a tasks panel lands.
   */
  const sessionViewContext: SessionViewContext = {
    feed,
    host,
    eventMode,
    onToggleEventMode: toggleEventMode,
    showCacheHits,
    onToggleCacheHits: toggleCacheHits,
    windowComposers,
    compact,
    tasksHost,
  };

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
    onRenameSession: setRenamingSession,
    detachedBotIds,
    onToggleBotOnCanvas: toggleBotOnCanvas,
    detachedSessionKeys,
    canvasOpenSessionKeys: canvasOpenKeys,
    onOpenSessionOnCanvas: openSessionOnCanvas,
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
        <SessionRenameDialog
          session={renamingSession}
          onClose={() => setRenamingSession(null)}
          onRename={renameSession}
        />
        <ForkSessionDialog
          request={forkRequest}
          // Every title in the source's project, so the proposal counts past the forks that are
          // already there. Read from the same list the sidebar renders, which is what the reader
          // is looking at when they press Fork.
          takenTitles={forkTitlesInProject}
          onClose={() => setForkRequest(null)}
          onFork={startFork}
        />
        <BotSessionPickerDialog
          open={botSessionPicker !== null}
          bot={botSessionPicker}
          sessions={botSessionPicker ? sessionsByProject.get(botSessionPicker.environment.path) : undefined}
          takenTitles={sessionTitlesInBot}
          onClose={() => setBotSessionPickerId(null)}
          onAttach={attachBotSessions}
          onStartNew={startNewSession}
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
                ? forkedSession.title
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
                title={forkedSession.sourceTitle}
                onClose={() => setForkedSession(null)}
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
                  externalError={botCommandError
                      && (botCommandError.session === null
                        || botCommandError.session
                          === `${displayedThread.session.source}:${displayedThread.session.sessionId}`)
                    ? botCommandError.message
                    : null}
                />
                <FileDropOverlay
                  dragging={threadDrop.dragging}
                  refusal={threadAcceptFiles === null
                    ? "This session has no composer to drop into"
                    : null}
                />
              </div>
            ) : sidebarMode === "canvas" ? (
              <BotCanvas
                bots={canvasBots}
                hues={botHues}
                loading={botsState.loading}
                error={botsState.error}
                sessionContext={sessionViewContext}
                botError={botCommandError}
                onAddSession={openBotSessionPicker}
                onForkSession={forkSession}
                onRenameSession={setRenamingSession}
                onDetachSession={detachBotSession}
                onRemoveSessionFromCanvas={removeSessionFromCanvas}
                onDetachBot={toggleBotOnCanvas}
                detachedCount={botsState.bots.length - canvasBots.length}
                detachedSessionKeys={detachedSessionKeys}
                openKeys={canvasOpenKeys}
                onToggleSession={toggleCanvasSession}
                onAddBot={() => setBotCreatorOpen(true)}
                newSessions={newSessions}
                onCloseNewSession={closeNewSession}
              />
            ) : sidebarMode === "sessions" ? (
              <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
                Select a session from Sessions
              </div>
            ) : null}
          </main>
          {forkedSession ? (
            <AgentTerminalPane
              key={forkedSession.sessionId}
              feed={feed}
              // Attaching, not starting: the Bot started this fork before this pane existed, so
              // opening it twice is the same as opening it once.
              context={{ kind: "tmux", session: forkedSession.tmuxSession }}
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

