import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { CornerDownLeft, List, LoaderCircle, PanelLeft, Send, Square, Terminal as TerminalIcon, X } from "lucide-react";
import type {
  AddBotCommand,
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentUiRequest,
  BotSessionRef,
  BotView,
  ProjectSummary,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import type {
  HostActionsClient,
} from "../features/activity-feed/data-source/HostActionsClient";
import {
  type QuestionPanelStatus,
  sidecarWindowComposerClient,
  WindowComposerError,
  type WindowComposerClient,
  type WindowComposerStatus,
  WindowQuestionError,
} from "../features/window-composer/WindowComposerClient";
import type { AgentSessionControlState, EventMode } from "../features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "../features/activity-feed/data-source/AgentDataSourceContext";
import { ActivityFeed } from "../features/activity-feed/ActivityFeed";
import { BackgroundTasksPanel } from "../features/background-tasks/BackgroundTasksPanel";
import { RunningTasksChip } from "../features/background-tasks/RunningTasksChip";
import { useBackgroundTasks } from "../features/background-tasks/useBackgroundTasks";
import { TokenMeter } from "../features/activity-feed/TokenMeter";
import type { TokenUsage } from "../features/activity-feed/useSessionEventsStream";
import { FontSizeRoot } from "../features/activity-feed/fontStore";
import { loadEventMode, storeEventMode } from "../features/activity-feed/eventModeStore";
import { loadCacheHitsVisible, storeCacheHitsVisible } from "../features/activity-feed/cacheHitStore";
import { SummaryBand } from "../features/summary/SummaryBand";
import { SummaryControl } from "../features/summary/SummaryControl";
import { useSummary } from "../features/summary/useSummary";
import { useDesktopPark } from "../features/desktop-park/useDesktopPark";
import { useUsage } from "../features/usage/useUsage";
import { cliInputReasonText, useCliInput, type CliInputHandle } from "../features/cli-input/useCliInput";
import type { OpenAskUserQuestion } from "./askUserQuestion";
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
import { BotCreatorDialog } from "../features/bots/BotCreatorDialog";
import { BotSessionPickerDialog } from "../features/bots/BotSessionPickerDialog";
import {
  AgentTerminalPane,
} from "../features/terminal/AgentTerminalPane";
import type { AgentTerminalState } from "../features/terminal/useAgentTerminal";
import { terminalContextKey } from "../features/terminal/terminalContext";
import {
  setTerminalDockPane,
  toggleTerminalDock,
  useTerminalDock,
} from "../features/terminal/terminalDockStore";

/**
 * A textarea that grows with its content instead of scrolling inside a fixed single row.
 *
 * Two measurements make this correct rather than approximately correct. `scrollHeight` is the
 * PADDING box and these fields are `border-box`, so the border has to be added back; without it
 * every field sits exactly its own border short of its content, which is visible immediately:
 * an empty field scrolls its placeholder, and the last pixels of a draft's final line are clipped.
 * And the growth is clamped at the element's own `max-height` rather than left for the cascade to
 * clamp, so a draft past the cap stops producing new heights -- otherwise every keystroke rewrites
 * the height, and the `auto` probe each rewrite needs resets the scroll away from the caret.
 *
 * Re-measured on the two things that change the wrap: the text, and the field's width (the sidebar
 * divider and the window both rewrap a draft without changing a character of it).
 */
function useAutoGrowingTextArea(value: string): (element: HTMLTextAreaElement | null) => void {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const border = element.offsetHeight - element.clientHeight;
    const cap = Number.parseFloat(getComputedStyle(element).maxHeight);
    const scrolled = element.scrollTop;
    element.style.height = "auto";
    const content = element.scrollHeight;
    // jsdom measures every box at zero. Writing that would collapse the field, so a degenerate
    // measurement hands the height back to the element's own `min-h`/`max-h` utilities.
    element.style.height = content > 0
      ? `${Math.min(content + border, Number.isNaN(cap) ? Infinity : cap)}px`
      : "";
    element.scrollTop = scrolled;
  }, []);

  useEffect(measure, [measure, value]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // Width only. Observing the field it also resizes would otherwise feed its own height changes
    // back in as fresh observations. Starts unset rather than at a measured width, because the
    // observer reports the content box and nothing here has read that box yet.
    let observed: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === observed) return;
      const first = observed === null;
      observed = width;
      if (!first) measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return useCallback(
    (element: HTMLTextAreaElement | null) => {
      ref.current = element;
      measure();
    },
    [measure],
  );
}

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

type TerminalState =
  | { kind: "idle" }
  | { kind: "loading"; context: AgentTerminalContext }
  | { kind: "ready"; context: AgentTerminalContext; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; context: AgentTerminalContext; code: string }
  | { kind: "ended"; context: AgentTerminalContext; exitStatus?: number };

interface AgentTerminalComposer {
  send: (text: string) => Promise<void>;
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
  const [terminal, setTerminal] = useState<TerminalState>({ kind: "idle" });
  const terminalComposer = useMemo<AgentTerminalComposer | null>(() => {
    if (terminal.kind !== "ready") return null;
    return {
      send: (text) => feed.sendTerminalPrompt(terminal.descriptor.terminalId, text),
    };
  }, [feed, terminal]);
  const [creatingProjectPath, setCreatingProjectPath] = useState<string | null>(null);
  const [creationErrors, setCreationErrors] = useState<Map<string, string>>(new Map());
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<AgentSessionControlState>({
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
  });
  // The on-demand turn digest. Keyed to the selected thread inside the hook, so switching
  // threads clears it rather than leaving one thread's summary under another's title.
  const summary = useSummary(
    feed,
    selectedThread
      ? { source: selectedThread.session.source, sessionId: selectedThread.session.sessionId }
      : null,
  );
  // This machine's per-day token usage, behind the sidebar's Profile section. The stream opens
  // when somebody asks for it, not on mount.
  const usage = useUsage(feed);
  // Gathering windows onto one Desktop is a machine-level capability, probed once
  // the same way usage is. Absent yabai, the menu entry stays disabled.
  const park = useDesktopPark(feed);
  // Both window composers are served by the sidecar and the standalone helper (ADR-0110). One client
  // per source, because the two resolve their window differently -- Claude by its process tree, Codex
  // by its own state joined to its accessibility tree -- and the sidecar is told which to run rather
  // than guessing. Built here, not in the composer, for the same reason `cliInput` is.
  const claudeComposer = useMemo(() => sidecarWindowComposerClient(feed, "claude"), [feed]);
  const codexComposer = useMemo(() => sidecarWindowComposerClient(feed, "codex"), [feed]);
  // Whether the selected thread is a Claude Code session running in someone's terminal, which is
  // what decides between the window composer and a plain send. Asked only for claude rows; every
  // other source leaves the hook inert and never issues a request.
  const cliInput = useCliInput(
    feed,
    selectedThread
      ? { source: selectedThread.session.source, sessionId: selectedThread.session.sessionId }
      : null,
    selectedThread?.session.source === "claude",
  );
  // The selected thread's context-window occupancy, mirrored up from ActivityFeed
  // and owned here so the composer band below the transcript can render it. Reset
  // when the thread changes so a stale count never survives a switch.
  const [sessionUsage, setSessionUsage] = useState<TokenUsage | null>(null);
  // The selected thread's open AskUserQuestion, mirrored up from ActivityFeed (the
  // feed owns the event stream the mirror's content derives from) and rendered by
  // the composer band below the transcript.
  const [openQuestion, setOpenQuestion] = useState<OpenAskUserQuestion | null>(null);
  const [extensionUI, setExtensionUI] = useState<AgentUiRequest[]>([]);
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
  const displayedThread = sidebarMode === "sessions"
    ? selectedThread
    : selectedBotId ? selectedThread : null;
  const selectedBotName = selectedBotId
    ? botsState.bots.find((bot) => bot.botId === selectedBotId)?.name
    : undefined;

  // The terminal dock's pane name, latched rather than read live.
  //
  // `cliInput` resets to idle on every re-read, and a tile mounted on its live value was torn
  // down and re-attached each time -- measured as a close/open cycle every ~2s in the network
  // log, with keystrokes typed into the gap going nowhere. The name is taken the first time it
  // arrives for the selected session and forgotten only when the selection moves, so nothing the
  // Feed does between those two moments can unmount the terminal.
  const selectedSessionId = displayedThread?.session.sessionId ?? null;
  const [dockedPane, setDockedPane] = useState<{ sessionId: string; tmuxSession: string } | null>(null);
  useEffect(() => {
    if (selectedSessionId && cliInput.tmuxSession) {
      setDockedPane({ sessionId: selectedSessionId, tmuxSession: cliInput.tmuxSession });
    }
  }, [selectedSessionId, cliInput.tmuxSession]);
  const dockedTmuxSession = dockedPane && dockedPane.sessionId === selectedSessionId
    ? dockedPane.tmuxSession
    : null;
  // Published, not rendered here. The terminal is mounted by the surface shell so that nothing in
  // this tree -- which re-renders on every status the Feed reads -- can unmount it mid-keystroke.
  // No cleanup: this component unmounts whenever another surface is selected, and clearing the
  // pane there would tear the attach down on a tab switch -- the very thing the dock exists to
  // avoid. The pane is replaced when the selection moves and cleared when it moves to a session
  // with no pane, both of which happen while this is mounted.
  useEffect(() => setTerminalDockPane(dockedTmuxSession), [dockedTmuxSession]);
  const dock = useTerminalDock();
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
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
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
  // The thread's own controls render into the header through this node, so the
  // feed does not spend a band of its own on them. Held in state, not a ref,
  // because the feed has to re-render once the node exists.
  const [threadControlsHost, setThreadControlsHost] = useState<HTMLDivElement | null>(null);
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

  // Extension-UI prompts arrive on the open thread's own stream, so they need no session filter
  // here and cannot outlive the thread that asked them: leaving a thread closes the stream, and
  // `openSession` clears whatever was still on screen.
  useEffect(
    () => feed.subscribeExtensionUI((event) => {
      if (event.type === "dismiss") {
        setExtensionUI((current) => current.filter((item) => item.requestId !== event.requestId));
        return;
      }
      const request = event.request;
      setExtensionUI((current) => {
        const next = [
          ...current.filter((item) => item.requestId !== request.requestId),
          request,
        ];
        const prompts = next.filter((item) => item.expectsResponse);
        const notices = next.filter((item) => !item.expectsResponse).slice(-8);
        return [...notices, ...prompts];
      });
    }),
    [feed],
  );

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

  const endCurrentTerminalContext = useCallback(() => {
    if (terminal.kind === "idle") return;
    setTerminal({ kind: "idle" });
  }, [terminal.kind]);

  const openSession = useCallback(
    (project: ProjectSummary, session: SessionSummary) => {
      if (selectedThread) endCurrentTerminalContext();
      setEventMode((current) => session.capabilities.modes.includes(current)
        ? current
        : (session.capabilities.modes[0] ?? "nice"));
      setCommandError(null);
      setSessionState({ runState: "idle", queue: { steer: 0, followUp: 0 } });
      setSessionUsage(null);
      setExtensionUI([]);
      setOpenQuestion(null);
      setSelectedThread({ project, session });
      storeSelection({
        projectPath: project.projectPath,
        source: session.source,
        sessionId: session.sessionId,
      });
      setHoverPreviewOpen(false);
      if (usesModalSidebar) setSidebarOpen(false);
    },
    [endCurrentTerminalContext, selectedThread, setSidebarOpen, usesModalSidebar],
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
    void feed
      .detachBotSessions(bot.botId, { sessionRefs: [target] })
      .catch((error: unknown) => {
        setCommandError(
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

  const openTerminal = useCallback(() => {
    if (!selectedThread) return;
    if (!isTerminalSource(selectedThread.session.source) || !selectedThread.session.capabilities.canOpenTerminal) return;
    const context: AgentTerminalContext = {
      kind: "agent-session",
      projectPath: selectedThread.project.projectPath,
      source: selectedThread.session.source,
      sessionId: selectedThread.session.sessionId,
    };
    setTerminal({ kind: "loading", context });
  }, [selectedThread]);

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

  const sendPrompt = useCallback(async (text: string, delivery: "next" | "steer") => {
    if (!selectedThread || commandPending || !text.trim()) return;
    const trimmed = text.trim();
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.sendMessage(selectedThread.session, trimmed, delivery);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      // Rethrow so the composer that owns the draft only clears it on success.
      throw error;
    } finally {
      setCommandPending(false);
    }
  }, [feed, commandPending, selectedThread]);

  const abortRun = useCallback(async () => {
    if (!selectedThread || commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.abortSession(selectedThread.session);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
    } finally {
      setCommandPending(false);
    }
  }, [feed, commandPending, selectedThread]);

  const closeTerminal = useCallback(() => {
    if (terminal.kind === "idle") return;
    setTerminal({ kind: "idle" });
  }, [terminal.kind]);

  const updateTerminalState = useCallback((context: AgentTerminalContext, state: AgentTerminalState) => {
    setTerminal((current) => {
      if (current.kind === "idle") return current;
      if (terminalContextKey(current.context) !== terminalContextKey(context)) return current;
      switch (state.kind) {
        case "ready":
          return { kind: "ready", context: current.context, descriptor: state.descriptor };
        case "error":
          return { kind: "error", context: current.context, code: state.message };
        case "ended":
          return { kind: "ended", context: current.context, exitStatus: state.exitStatus };
      }
    });
  }, []);

  // Addresses the selected session for the task stream. `mode` is required by the reference type
  // but means nothing here -- background tasks are not read in a transcript view -- so it is
  // pinned rather than threaded through, which would invite it to matter.
  const taskSession = useMemo(
    () =>
      selectedThread
        ? { source: selectedThread.session.source, sessionId: selectedThread.session.sessionId, mode: "nice" as const }
        : null,
    [selectedThread],
  );
  const backgroundTasks = useBackgroundTasks(feed, taskSession);
  const runningTaskCount = backgroundTasks.running.length;
  // Closed on a session switch, and only then. An earlier version also closed it when the last
  // task ended, which turned out to be exactly wrong: watching a task finish is the moment the
  // panel is most wanted, and it vanished at the instant the result arrived. Left open, it shows
  // "Nothing running" above the finished list, which is the answer the viewer was waiting for.
  useEffect(() => {
    setTasksPanelOpen(false);
  }, [selectedThread?.session.sessionId]);

  // One subscription for all three sidebar mounts. Owned here rather than inside the sidebar so
  // the pinned rail, the hover preview, and the phone drawer share one stream instead of opening
  // one each; only two of them are ever mounted at once, but the report should not be fetched
  // twice when they are.
  const sidebarProps = {
    mode: sidebarMode,
    onModeChange: setSidebarMode,
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
    onAddBotSession: (bot: BotView) => {
      setBotSessionPickerId(bot.botId);
      setHoverPreviewOpen(false);
    },
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
              {sidebarMode === "bots"
                ? selectedBotName || "Bots"
                : displayedThread?.session.title || displayedThread?.session.sessionId || "Agent Feed"}
            </h1>
            <div ref={setThreadControlsHost} className="flex shrink-0 items-center" />
            {displayedThread && summary.available ? (
              <SummaryControl
                state={summary.state}
                running={sessionState.runState === "running"}
                onSummarize={summary.summarize}
              />
            ) : null}
            {displayedThread?.session.capabilities.canOpenTerminal && isTerminalSource(displayedThread.session.source) ? (
              <TerminalControl
                source={displayedThread.session.source}
                state={terminal}
                onOpen={openTerminal}
                onClose={closeTerminal}
              />
            ) : null}
          </header>

          {/* ActivityFeed remains the only thread scroll owner. The sidebar has
              its own scroller, so sticky transcript headers and virtualization
              still read the same scrollTop they did before this shell changed. */}
          <main className="min-h-0 flex-1 overflow-hidden bg-background">
            {displayedThread ? (
              <div
                key={`${displayedThread.session.sessionId}:${eventMode}`}
                className="h-full"
              >
                <ActivityFeed
                  source={displayedThread.session.source}
                  sessionId={displayedThread.session.sessionId}
                  mode={eventMode}
                  onToggleMode={toggleEventMode}
                  canToggleMode={displayedThread.session.capabilities.modes.length > 1}
                  showCacheHits={showCacheHits}
                  onToggleCacheHits={toggleCacheHits}
                  controlsHost={threadControlsHost}
                  onSessionState={setSessionState}
                  onUsage={setSessionUsage}
                  onOpenQuestion={setOpenQuestion}
                />
              </div>
            ) : sidebarMode === "sessions" ? (
              <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
                Select a session from Sessions
              </div>
            ) : null}
          </main>
          {displayedThread?.session.capabilities.supportsExtensionUi ? (
            <ExtensionUISurface
              requests={extensionUI}
              onRespond={async (request, value) => {
                setCommandError(null);
                try {
                  await feed.respondToExtensionUI(displayedThread.session, request.requestId, value);
                } catch (error) {
                  setCommandError(String((error as Error).message ?? error));
                  throw error;
                }
              }}
              onDismiss={(request) =>
                setExtensionUI((current) => current.filter((item) => item.requestId !== request.requestId))}
            />
          ) : null}
          {/* One composer band for every source. The UI is shared code; the send
              mechanism is selected explicitly: native window, CLI inbox, then an
              already-open Agent Feed pty; Pi reaches its harness. The context meter lives here, below the action row,
              instead of in the header. Keyed by session so switching threads
              remounts rather than carrying a draft written for one session into
              another. */}
          {/* Above the composer, below the transcript. Not rows in the feed: ActivityFeed is the
              thread's only scroll owner and synthetic rows would fight its tail-follow. */}
          {displayedThread ? (
            <SummaryBand state={summary.state} model={summary.model} onDismiss={summary.dismiss} />
          ) : null}
          {displayedThread && taskSession ? (
            <RunningTasksChip
              count={runningTaskCount}
              open={tasksPanelOpen}
              onToggle={() => setTasksPanelOpen((open) => !open)}
            />
          ) : null}
          {displayedThread ? (
            <SessionComposer
              key={displayedThread.session.sessionId}
              host={host}
              feed={feed}
              session={displayedThread.session}
              state={sessionState}
              usage={sessionUsage}
              pending={commandPending}
              error={commandError}
              question={openQuestion}
              cliInput={cliInput}
              windowComposerClient={
                displayedThread.session.source === "codex" ? codexComposer : claudeComposer
              }
              agentTerminal={terminalComposer}
              terminalDock={dockedTmuxSession
                ? { tmuxSession: dockedTmuxSession, shown: dock.shown, toggle: toggleTerminalDock }
                : null}
              onSendMessage={sendPrompt}
              onAbort={abortRun}
            />
          ) : null}
          {displayedThread && isTerminalSource(displayedThread.session.source) ? (
            <TerminalNotice source={displayedThread.session.source} state={terminal} />
          ) : null}
          {displayedThread && (terminal.kind === "loading" || terminal.kind === "ready") ? (
            <AgentTerminalPane
              feed={feed}
              context={terminal.context}
              onState={updateTerminalState}
            />
          ) : null}
        </div>
        {/* Outside the main column, so on the Mac it is a real column beside the thread rather
            than a band inside it. On a phone it renders as a sheet over everything, and the
            `compact` switch deciding which is the shell's own, not a second rule. */}
        {displayedThread && tasksPanelOpen && taskSession ? (
          <BackgroundTasksPanel
            compact={compact}
            snapshot={backgroundTasks}
            source={feed}
            session={taskSession}
            onClose={() => setTasksPanelOpen(false)}
          />
        ) : null}
      </div>
    </DataSourceProvider>
  );
}

function isTerminalSource(source: string): source is "claude" | "codex" {
  return source === "claude" || source === "codex";
}

function harnessName(source: "claude" | "codex"): string {
  return source === "claude" ? "Claude" : "Codex";
}

function SessionComposer({
  host,
  feed,
  session,
  state,
  usage,
  pending,
  error,
  question,
  cliInput,
  windowComposerClient,
  agentTerminal,
  terminalDock,
  onSendMessage,
  onAbort,
}: {
  host: HostActionsClient;
  feed: SidecarDataSource;
  session: SessionSummary;
  state: AgentSessionControlState;
  usage: TokenUsage | null;
  pending: boolean;
  error: string | null;
  /**
   * The session's open AskUserQuestion, derived from the feed's event stream. null
   * while no question is open, which is when no mirror renders and no question
   * watch exists.
   */
  question: OpenAskUserQuestion | null;
  /**
   * Whether this session is a Claude Code process in a terminal, and the way to type into it.
   * Resolved by the app, because it is a sidecar read and this component takes only the host.
   */
  cliInput: CliInputHandle;
  /**
   * This session's window composer, bound to its source. Resolved by the app, because it is a
   * sidecar read and this component takes only the host.
   */
  windowComposerClient: WindowComposerClient;
  /** The already-open Agent Feed pty, or null while no owned terminal is ready. */
  agentTerminal: AgentTerminalComposer | null;
  /**
   * The floating terminal for this session's tmux pane, owned by the app. This band only offers
   * the switch; null when the session has no pane, which is when there is nothing to switch to.
   */
  terminalDock: { tmuxSession: string; shown: boolean; toggle: () => void } | null;
  onSendMessage: (text: string, delivery: "next" | "steer") => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const { source, sessionId, capabilities } = session;
  const isClaude = source === "claude";
  const isCodex = source === "codex";
  const inboxCandidate = isClaude && cliInput.isTerminalSession;
  const windowCandidate = (isClaude || isCodex) && !inboxCandidate;
  const running = state.runState === "running";
  const queued = state.queue.followUp + state.queue.steer;

  // A Claude or Codex session being shown in a window reaches its prompt through that window's
  // composer. The hook is inert -- and never subscribes -- for every other source AND for a
  // terminal session, so hook order here never varies. Codex reads are free on any Desktop, so it
  // skips the off-Desktop bring-and-move-back round trip Claude's windows need.
  const windowComposer = useWindowComposer(
    windowComposerClient,
    sessionId,
    windowCandidate,
    isCodex ? "Codex" : "Claude",
    isCodex,
  );

  // Delivery priority is one explicit state, not several independent availability flags. A live
  // native window owns composition first. A Claude CLI inbox owns it next. Only a KNOWN native
  // refusal or an unavailable inbox may fall through to the Agent Feed pty, and only while that
  // pty is already open. Opening a process remains an explicit action in the terminal control.
  const transport:
    | { kind: "window" }
    | { kind: "cli-inbox" }
    | { kind: "agent-terminal"; terminal: AgentTerminalComposer }
    | { kind: "agent-session" } = inboxCandidate
      ? cliInput.available
        ? { kind: "cli-inbox" }
        : agentTerminal
          ? { kind: "agent-terminal", terminal: agentTerminal }
          : { kind: "cli-inbox" }
      : windowCandidate
        ? windowComposer.statusKnown && !windowComposer.enabled && agentTerminal
          ? { kind: "agent-terminal", terminal: agentTerminal }
          : { kind: "window" }
        : { kind: "agent-session" };
  const windowBand = transport.kind === "window";
  const inboxBand = transport.kind === "cli-inbox";
  const agentTerminalBand = transport.kind === "agent-terminal";
  // The AskUserQuestion mirror is Claude-only too, and only while the feed says a
  // question is open. Its content comes from the transcript JSON; the hook adds
  // the focus-gated watch for live state and the press actions.
  //
  // Left running for a terminal session, where it renders the question and disables its buttons,
  // because that is what it did before this band existed and what it should keep doing: the
  // question is real and worth reading. Pressing one would mean delivering the answer through the
  // inbox instead of through a window, which is a different feature from typing a turn.
  const questionPanel = useClaudeWindowQuestion(
    windowComposerClient,
    sessionId,
    isClaude && question != null,
    question,
  );

  // Every non-window transport composes against local state. If native resolution refuses after
  // somebody has already typed, hand that exact draft to the selected local transport before the
  // native watcher releases ownership.
  const [localDraft, setLocalDraft] = useState("");
  const previousTransport = useRef(transport.kind);
  useEffect(() => {
    if (previousTransport.current === "window" && transport.kind !== "window") {
      setLocalDraft((current) => current.length > 0 ? current : windowComposer.draft);
      windowComposer.stopWatching();
    }
    previousTransport.current = transport.kind;
  }, [transport.kind, windowComposer.draft, windowComposer.stopWatching]);
  const editorValue = windowBand ? windowComposer.draft : localDraft;
  const autoGrow = useAutoGrowingTextArea(editorValue);

  const [deliveryPending, setDeliveryPending] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const piUnavailable = !isClaude && !isCodex && !capabilities.canSend;
  const unavailable = windowBand
    ? false
    : inboxBand
      // A terminal session that stopped running: the field stays visible with the reason under
      // it, rather than swapping the whole band out from under someone mid-sentence.
      ? !cliInput.available
      : agentTerminalBand
        ? false
        : piUnavailable;

  const editor: {
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
    ariaLabel: string;
    placeholder: string;
    maxLength: number;
    sendOnEnter: boolean;
    onFocus?: () => void;
    onBlur?: () => void;
  } = windowBand
    ? {
        value: windowComposer.draft,
        onChange: (value: string) => windowComposer.change(value),
        // Focusable before the first status, because the watch is focus-gated: a field disabled
        // "until a status arrives" could never be focused, so it could never trigger the watch that
        // delivers the status. Only a KNOWN reason disables it.
        disabled: (windowComposer.statusKnown && !windowComposer.enabled) || windowComposer.pending,
        ariaLabel: isCodex ? "Codex composer text" : "Claude composer text",
        // Three states, three strings. `enabled` is false BEFORE the first status as well as after
        // a refusal, and the watch is focus-gated, so keying the placeholder on it alone labelled
        // every unfocused window session "Composer unavailable" -- including one whose window was
        // sitting there resolvable, which is what a passive surface like the Bots tab shows all the
        // time. The placeholder now agrees with `disabled` right above it, which already treats an
        // unknown status as usable.
        placeholder: !windowComposer.statusKnown || windowComposer.enabled
          ? isCodex
            ? "Type into Codex's composer…"
            : "Type into Claude's composer…"
          : "Composer unavailable",
        maxLength: 100_000,
        sendOnEnter: false,
        onFocus: windowComposer.onFocus,
        onBlur: windowComposer.onBlur,
      }
    : inboxBand
    ? {
        value: localDraft,
        onChange: unavailable ? () => {} : setLocalDraft,
        disabled: unavailable || deliveryPending,
        ariaLabel: "Message this terminal session",
        placeholder: unavailable
          ? "Session not reachable"
          : "Send to the terminal session\u2026",
        // The window band's limit, not Pi's: this is the same act, typing into a session someone
        // else owns, and the sidecar refuses more than the harness's inbox should carry.
        maxLength: 100_000,
        sendOnEnter: !unavailable,
        // The status is re-read here rather than on a timer: focus is the moment someone intends
        // to type, so it is the moment a stale "not running" is worth correcting.
        onFocus: cliInput.refresh,
      }
    : agentTerminalBand
    ? {
        value: localDraft,
        onChange: setLocalDraft,
        disabled: deliveryPending,
        ariaLabel: "Message through Agent Feed terminal",
        placeholder: "Send through the open terminal…",
        maxLength: 64 * 1024,
        sendOnEnter: true,
      }
    : {
        value: localDraft,
        onChange: unavailable ? () => {} : setLocalDraft,
        disabled: unavailable || pending,
        ariaLabel: "Message Pi",
        placeholder: unavailable
          ? "Composer unavailable"
          : running
            ? "Queue the next instruction…"
            : "Message Pi…",
        maxLength: 200_000,
        sendOnEnter: !unavailable,
      };

  /**
   * One turn through a transport owned outside the panel's agent-session queue.
   *
   * Separate from `submit` rather than folded into it because the two do different things: this
   * is a delivery to a CLI inbox or an already-open pty, with no queue to join and nothing to
   * steer. The draft survives a refusal so nothing is lost.
   */
  const submitOwnedTransport = async () => {
    if (deliveryPending || !editorValue.trim()) return;
    const text = editorValue.trim();
    setDeliveryPending(true);
    setDeliveryError(null);
    try {
      if (transport.kind === "agent-terminal") {
        await transport.terminal.send(text);
        setLocalDraft("");
      } else if (transport.kind === "cli-inbox" && await cliInput.send(text)) {
        setLocalDraft("");
      }
    } catch (failure) {
      setDeliveryError(String((failure as Error).message ?? failure));
    } finally {
      setDeliveryPending(false);
    }
  };

  const submit = async (delivery: "next" | "steer") => {
    if (inboxBand || agentTerminalBand) return await submitOwnedTransport();
    if (pending || !editorValue.trim()) return;
    const text = editorValue.trim();
    try {
      await onSendMessage(text, delivery);
      setLocalDraft("");
    } catch {
      // The shell's caption carries the reason; keep the draft so nothing is lost.
    }
  };

  const actions: ComposerAction[] = [];
  if (windowBand) {
    // The window band's only explicit action is the Enter button: filling and
    // reading are automatic (focus prefill, debounced sync, one round trip for
    // an off-Desktop window), so there is nothing left to button.
    actions.push({
      key: "submit-window",
      ariaLabel: isCodex ? "Send to Codex's composer" : "Send to Claude's composer",
      title: isCodex
        ? "Fill and press Enter in Codex, sending the prompt now"
        : "Fill and press Enter in Claude, sending the prompt now",
      icon: windowComposer.pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        <CornerDownLeft className="size-4" aria-hidden />
      ),
      disabled: !windowComposer.canSubmit || windowComposer.pending,
      className:
        "flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40",
      onClick: () => void windowComposer.submitWindow(),
    });
  } else if (inboxBand || agentTerminalBand) {
    // One action, deliberately. Steer and Stop act on a queue the panel owns; a terminal session
    // owns its own, and the person at that keyboard is the one who can interrupt it.
    actions.push({
      key: agentTerminalBand ? "send-agent-terminal" : "send-inbox",
      ariaLabel: agentTerminalBand ? "Send through Agent Feed terminal" : "Send to the terminal session",
      title: agentTerminalBand ? "Send through the open Agent Feed terminal" : "Send to the terminal session",
      icon: deliveryPending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        <Send className="size-4" aria-hidden />
      ),
      disabled: unavailable || deliveryPending || !editorValue.trim(),
      className:
        "flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40",
      onClick: () => void submitOwnedTransport(),
    });
  } else if (!unavailable) {
    if (running && capabilities.canSteer) {
      actions.push({
        key: "steer",
        ariaLabel: "Steer",
        title: "Steer",
        icon: <span>Steer</span>,
        disabled: pending || !editorValue.trim(),
        className:
          "h-9 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40",
        onClick: () => void submit("steer"),
      });
    }
    if (running && capabilities.canAbort) {
      actions.push({
        key: "abort",
        ariaLabel: "Stop agent",
        title: "Stop agent",
        icon: <Square className="size-3.5 fill-current" aria-hidden />,
        disabled: pending,
        className:
          "flex size-9 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 disabled:opacity-40",
        onClick: () => void onAbort(),
      });
    }
    actions.push({
      key: "send",
      ariaLabel: running ? "Queue message" : "Send message",
      title: running ? "Queue message" : "Send message",
      icon: pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        <Send className="size-4" aria-hidden />
      ),
      disabled: pending || !editorValue.trim(),
      className:
        "flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40",
      onClick: () => void submit("next"),
    });
  }

  let caption: string | null = null;
  let captionIsError = false;
  if (windowBand) {
    caption = windowComposer.error ?? windowComposer.notice;
    captionIsError = windowComposer.error != null;
  } else if (inboxBand) {
    // The reason outranks a transport error: "this session is not running" explains the failure,
    // where the message from a request that never had anywhere to go does not.
    caption = cliInput.reason ? cliInputReasonText(cliInput.reason) : deliveryError;
    captionIsError = cliInput.reason != null || deliveryError != null;
  } else if (agentTerminalBand) {
    caption = deliveryError ?? "Sending through the open Agent Feed terminal.";
    captionIsError = deliveryError != null;
  } else if (unavailable) {
    caption = "This session's composer is unavailable.";
  } else if (error) {
    caption = error;
    captionIsError = true;
  } else if (queued > 0) {
    caption = `${queued} queued${state.queue.steer ? `, ${state.queue.steer} steering` : ""}`;
  }

  const sectionLabel = inboxBand
    ? "Terminal session composer"
    : agentTerminalBand
    ? "Agent Feed terminal composer"
    : isClaude
    ? "Claude window composer"
    : isCodex
      ? "Codex composer"
      : "Agent prompt";

  return (
    <section aria-label={sectionLabel} className="shrink-0 border-t border-border bg-card px-6 py-3">
      {questionPanel.visible ? (
        <AskUserQuestionMirror
          question={questionPanel.question!}
          optionsExpanded={questionPanel.optionsExpanded}
          selected={questionPanel.selected}
          otherText={questionPanel.otherText}
          otherChecked={questionPanel.otherChecked}
          pending={questionPanel.pending}
          disabled={!questionPanel.enabled}
          error={questionPanel.error}
          onSelectOption={questionPanel.selectOption}
          onChangeOther={questionPanel.changeOther}
          onToggleOther={questionPanel.toggleOther}
          onToggleOptions={questionPanel.toggleOptions}
          onSubmit={questionPanel.submit}
          onSkip={questionPanel.skip}
          onDismiss={questionPanel.dismiss}
        />
      ) : null}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={autoGrow}
          value={editor.value}
          onChange={(event) => editor.onChange(event.target.value)}
          onFocus={editor.onFocus}
          onBlur={editor.onBlur}
          onKeyDown={(event) => {
            if (
              editor.sendOnEnter &&
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit("next");
            }
          }}
          maxLength={editor.maxLength}
          rows={1}
          placeholder={editor.placeholder}
          aria-label={editor.ariaLabel}
          disabled={editor.disabled}
          className="max-h-48 min-h-12 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-3 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 shadow-xs outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-40"
        />
        {/* Offered only where there is a pane: a session without one has nothing to show. */}
        {terminalDock ? (
          <button
            type="button"
            onClick={terminalDock.toggle}
            aria-pressed={terminalDock.shown}
            aria-label={terminalDock.shown ? "Hide the terminal" : "Show the terminal"}
            title={terminalDock.shown
              ? `Hide the ${terminalDock.tmuxSession} terminal.`
              : `Show the ${terminalDock.tmuxSession} terminal.`}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
              terminalDock.shown
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {"\u2b1a"}
          </button>
        ) : null}
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.ariaLabel}
            title={action.title}
            className={action.className}
          >
            {action.icon}
          </button>
        ))}
      </div>
      {/* The context meter sits below the action row, right-aligned under the
          buttons in the window band, not in the header. */}
      {usage ? (
        <div className="mt-1 flex justify-end px-1">
          <TokenMeter usage={usage} />
        </div>
      ) : null}
      {caption ? (
        <p
          {...(isClaude || isCodex
            ? { "aria-live": "polite" as const }
            : { role: captionIsError ? ("alert" as const) : ("status" as const) })}
          className={`px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) ${
            captionIsError ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {caption}
        </p>
      ) : null}
    </section>
  );
}

/** One action in the composer's action row, rendered in array order. */
type ComposerAction = {
  key: string;
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  disabled: boolean;
  className: string;
  onClick: () => void;
};

/**
 * The window-composer mechanism, extracted from the shared band so the band
 * itself is one component for every source. Inert -- and never subscribing --
 * when `active` is false, so a Pi session posts no `agent-window-input-watch`.
 *
 * Claude and Codex both reach the session's prompt through the owning desktop
 * app's window composer: the host resolves the session to its window (Claude
 * through the process tree, Codex through the app's own thread registry and
 * each window's accessibility header) and writes the field over Accessibility.
 *
 * The watch is FOCUS-gated: the field subscribes when focused and unwatches on
 * blur, which stops the host's resolution poll and the AX value observer while
 * nobody is composing. While focused the sync is automatic: the window's text
 * is prefilled on focus, every edit pushes the full value to the window after
 * a debounce, and value-changed events from the window reconcile the field --
 * an echo of our own write marks it in sync, an independent edit in the app
 * updates it while idle. Enter stays the one explicit action.
 */
function useWindowComposer(
  host: WindowComposerClient,
  sessionId: string,
  active: boolean,
  windowName: string,
  /**
   * True when the owning app's composer reads are free on any Desktop (Codex Desktop materializes
   * accessibility trees for every window, so the watch status always carries the text). Free reads
   * skip the one automatic bring-and-move-back round trip that Claude's off-Desktop windows need.
   */
  freeReads: boolean,
) {
  const [status, setStatus] = useState<WindowComposerStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const statusRef = useRef<WindowComposerStatus | null>(null);
  const draftRef = useRef("");
  const edited = useRef(false);
  const inSync = useRef(true);
  const roundTripDone = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraftBoth = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
  }, []);

  const adopt = useCallback(
    (text: string) => {
      edited.current = false;
      inSync.current = true;
      setDraftBoth(text);
    },
    [setDraftBoth],
  );

  const change = useCallback(
    (value: string) => {
      edited.current = true;
      inSync.current = false;
      setDraftBoth(value);
    },
    [setDraftBoth],
  );

  const reportFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof WindowComposerError
        ? composerReasonText(failure.reason)
        : String((failure as Error).message ?? failure),
    );
  }, []);

  const run = useCallback(
    async (operation: () => Promise<string>) => {
      setPending(true);
      setError(null);
      try {
        adopt(await operation());
      } catch (failure) {
        reportFailure(failure);
      } finally {
        setPending(false);
      }
    },
    [adopt, reportFailure],
  );

  // The automatic push behind edits made while the window is already here. Deliberately silent: it
  // is the field's own echo, so no spinner freezes the field mid-keystroke, and the caption carries
  // the reason when the window refused. The result is NOT adopted: the write's read-back can lag the
  // draft (the user keeps typing while the host settles the write), and the field must never be
  // replaced by stale text. The write echo arrives as a status and the status handler reconciles it;
  // the draft stays so nothing is lost, and the next edit retries.
  const push = useCallback(async () => {
    // The focused watch borrows an off-Desktop Claude window once and reports it active before live
    // syncing begins. A false status means the lease was not acquired, so keep the draft local instead
    // of falling back to per-keystroke move-in/move-back traffic.
    if (statusRef.current?.onActiveDesktop !== true) return;
    try {
      await host.syncWindowComposer(sessionId, draftRef.current);
    } catch (failure) {
      reportFailure(failure);
    }
  }, [host, reportFailure, sessionId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const text = await host.readWindowComposer(sessionId);
      // Adopt only when no keystroke landed while the read was in flight: the
      // window's text is older than a draft the user typed in the meantime, and
      // replacing the draft would delete what they just wrote.
      if (!edited.current) {
        adopt(text);
      }
    } catch (failure) {
      reportFailure(failure);
    }
  }, [adopt, host, reportFailure, sessionId]);

  const submitWindow = useCallback(
    () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      return run(() => host.submitWindowComposer(sessionId, draftRef.current));
    },
    [host, run, sessionId],
  );

  // The focus-gated watch: subscribing makes the host's forced status prefill
  // the field and starts the poll plus the AX value observer; the cleanup on
  // blur unwatches, which stops all of it.
  useEffect(() => {
    if (!active || !focused) return;
    roundTripDone.current = false;
    return host.subscribeWindowComposer(sessionId, (next) => {
      statusRef.current = next;
      setStatus(next);
      if (next.composerText === null) {
        // Compatibility fallback for a host that could resolve the window but could not acquire an
        // editing lease. Read once without disabling the local field.
        if (!freeReads && next.enabled && !next.onActiveDesktop && !roundTripDone.current) {
          roundTripDone.current = true;
          void load();
        }
        return;
      }
      if (!edited.current) {
        // Fresh prefill (or an independent edit while idle): the window is the source.
        inSync.current = true;
        setDraftBoth(next.composerText);
      } else if (next.composerText === draftRef.current) {
        // The echo of our own write: field and window agree again, so later independent edits are
        // adopted instead of being guarded forever by the "unsent edit" flag.
        edited.current = false;
        inSync.current = true;
      }
    });
  }, [active, host, focused, freeReads, load, sessionId, setDraftBoth]);

  // Debounced auto-sync while the owning window is here, either originally or under the focused watch's
  // editing lease. Every edit pushes the full value 500ms after the last keystroke.
  useEffect(() => {
    if (!active || !focused || inSync.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      void push();
    }, 500);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [active, draft, focused, push, status?.onActiveDesktop]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    // Flush anything still inside the debounce window before the watch drops.
    if (!inSync.current) void push();
    setFocused(false);
  }, [push]);

  // Releases the native watch without flushing. Used only when another transport has taken the
  // draft after a known native refusal, so retrying a write into that refused window would be both
  // wasted work and a second owner for the same prompt.
  const stopWatching = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setFocused(false);
  }, []);

  const enabled = status?.enabled === true;
  const notice =
    status === null
      ? focused
        ? `Looking for this session's ${windowName} window…`
        : null
      : enabled
        ? null
        : composerReasonText(status.reason);

  return {
    enabled,
    statusKnown: status !== null,
    onActiveDesktop: status?.onActiveDesktop === true,
    draft,
    change,
    submitWindow,
    pending,
    error,
    canSubmit: enabled && draft.trim().length > 0,
    notice,
    onFocus,
    onBlur,
    stopWatching,
  };
}

/**
 * The AskUserQuestion mirror's mechanism, mirroring the composer hook's shape.
 *
 * The watch is active while the FEED says a question is open, not focus-gated like the composer:
 * a question panel is a transient, modal surface that appears only while the model is waiting for
 * an answer, so the status poll exists only for that window, and the panel's pre-checked state
 * (Claude pre-selects options) must appear before any interaction. The mirror's CONTENT comes from
 * the transcript JSON via `question`; this hook only watches the live AX state and drives presses.
 *
 * The reconcile rule matches the composer: our own action results are always adopted (they are the
 * echo of a press that landed), while status updates respect an in-flight "Other" edit so a poll
 * arriving between keystrokes cannot clobber them.
 */
function useClaudeWindowQuestion(
  host: WindowComposerClient,
  sessionId: string,
  active: boolean,
  question: OpenAskUserQuestion | null,
) {
  const [status, setStatus] = useState<QuestionPanelStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [otherText, setOtherText] = useState("");
  const [otherChecked, setOtherChecked] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const selectedRef = useRef<number[]>([]);
  const otherTextRef = useRef("");
  const otherEdited = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    otherTextRef.current = otherText;
  }, [otherText]);

  // A new question (new callId) starts a fresh mirror: no carried-over selection or
  // Other text from the previous question, and a fresh status read on the new watch.
  useEffect(() => {
    setStatus(null);
    setError(null);
    setSelected([]);
    setOtherText("");
    setOtherChecked(false);
    setOptionsExpanded(false);
    otherEdited.current = false;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, [question?.callId]);

  const reportFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof WindowQuestionError
        ? composerReasonText(failure.reason)
        : String((failure as Error).message ?? failure),
    );
  }, []);

  /** Adopts a status update, respecting an in-flight Other edit. */
  const adoptFromStatus = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    if (!otherEdited.current) {
      setOtherText(next.otherText ?? "");
      setOtherChecked((next.otherText?.length ?? 0) > 0);
    }
  }, []);

  /** Adopts our own action's post-action state unconditionally. */
  const adoptFromResult = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    otherEdited.current = false;
    setOtherText(next.otherText ?? "");
    setOtherChecked((next.otherText?.length ?? 0) > 0);
  }, []);

  const run = useCallback(
    async (operation: () => Promise<QuestionPanelStatus>) => {
      setPending(true);
      setError(null);
      try {
        adoptFromResult(await operation());
      } catch (failure) {
        reportFailure(failure);
      } finally {
        setPending(false);
      }
    },
    [adoptFromResult, reportFailure],
  );

  useEffect(() => {
    if (!active) return;
    return host.subscribeWindowQuestion(sessionId, adoptFromStatus);
  }, [active, adoptFromStatus, host, sessionId]);

  const selectOption = useCallback(
    (index: number) => {
      if (question?.multiSelect) {
        const desired = !selectedRef.current.includes(index);
        // Optimistic toggle; the host presses only on mismatch and the result reconciles.
        setSelected((current) =>
          desired ? [...current, index] : current.filter((entry) => entry !== index),
        );
        void run(() => host.selectQuestionOption(sessionId, index, desired));
      } else {
        setSelected([index]);
        void run(() => host.selectQuestionOption(sessionId, index, true));
      }
    },
    [host, question?.multiSelect, run, sessionId],
  );

  // The automatic push behind every Other keystroke, debounced like the composer's
  // sync. Deliberately silent: no spinner freezes the input mid-keystroke, and the
  // caption carries the reason when the window refused.
  const pushOther = useCallback(async () => {
    const sent = otherTextRef.current;
    try {
      const result = await host.setQuestionOther(sessionId, sent);
      // An edit during flight superseded this push; adopting the stale echo would
      // clobber the newer text. Keep the status, drop the stale text.
      if (otherTextRef.current === sent) {
        adoptFromResult(result);
      } else {
        setStatus(result);
      }
    } catch (failure) {
      reportFailure(failure);
    }
  }, [adoptFromResult, host, reportFailure, sessionId]);

  const changeOther = useCallback(
    (text: string) => {
      otherEdited.current = true;
      setOtherText(text);
      setOtherChecked(text.length > 0);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void pushOther();
      }, 500);
    },
    [pushOther],
  );

  const toggleOther = useCallback(() => {
    if (otherChecked) {
      otherEdited.current = true;
      setOtherText("");
      setOtherChecked(false);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void pushOther();
      }, 500);
    }
    // Turning Other on just means the user is about to type; the input takes focus.
  }, [otherChecked, pushOther]);

  const submit = useCallback(
    () => run(() => host.submitQuestion(sessionId)),
    [host, run, sessionId],
  );
  const skip = useCallback(
    () => run(() => host.skipQuestion(sessionId)),
    [host, run, sessionId],
  );
  const dismiss = useCallback(
    () => run(() => host.dismissQuestion(sessionId)),
    [host, run, sessionId],
  );
  const toggleOptions = useCallback(() => {
    setOptionsExpanded((current) => !current);
    void run(() => host.toggleQuestionOptions(sessionId));
  }, [host, run, sessionId]);

  // Mirror-composer discipline: only a KNOWN reason disables the controls; before
  // any status they stay usable so the watch (and its forced read) can start.
  const enabled = status?.enabled !== false;
  const canSubmit =
    question != null &&
    enabled &&
    (selected.length > 0 || otherText.trim().length > 0);
  const notice = status?.enabled === false ? composerReasonText(status.reason) : null;

  return {
    visible: question != null && status?.present !== false,
    question,
    optionsExpanded,
    selected,
    otherText,
    otherChecked,
    pending,
    enabled,
    error: error ?? notice,
    canSubmit,
    selectOption,
    changeOther,
    toggleOther,
    toggleOptions,
    submit,
    skip,
    dismiss,
  };
}

/**
 * The AskUserQuestion mirror: Claude's question panel, rendered from the transcript
 * JSON and actuated through the host's AX presses. Mirrors the real panel's controls
 * -- question, options, Other input, Skip, Submit -- plus its header's View options
 * and Dismiss affordances.
 */
function AskUserQuestionMirror({
  question,
  optionsExpanded,
  selected,
  otherText,
  otherChecked,
  pending,
  disabled,
  error,
  onSelectOption,
  onChangeOther,
  onToggleOther,
  onToggleOptions,
  onSubmit,
  onSkip,
  onDismiss,
}: {
  question: OpenAskUserQuestion;
  optionsExpanded: boolean;
  selected: number[];
  otherText: string;
  otherChecked: boolean;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onSelectOption: (index: number) => void;
  onChangeOther: (text: string) => void;
  onToggleOther: () => void;
  onToggleOptions: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}) {
  const inert = pending || disabled;
  return (
    <section
      aria-label="Claude question"
      className="mb-3 rounded-xl border border-border bg-background p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground">
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleOptions}
            disabled={inert}
            aria-label="View question options"
            aria-expanded={optionsExpanded}
            title={optionsExpanded ? "Collapse option descriptions" : "Expand option descriptions"}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <List className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={inert}
            aria-label="Dismiss question"
            title="Dismiss the question without answering"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {question.header ? (
        <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {question.header}
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        {question.options.map((option, index) => {
          const checked = selected.includes(index);
          const id = `ask-user-question-option-${index}`;
          return (
            <div
              key={index}
              className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
            >
              <input
                id={id}
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.multiSelect ? undefined : "ask-user-question"}
                checked={checked}
                disabled={inert}
                onChange={() => onSelectOption(index)}
                aria-label={option.label}
                className="mt-1 size-4 accent-primary"
              />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 cursor-pointer text-(length:--agent-panel-fs-sidebar-body,15px) leading-6"
              >
                <span className="font-medium text-foreground">{option.label}</span>
                {optionsExpanded && option.description ? (
                  <span className="block whitespace-pre-wrap text-(length:--agent-panel-fs-sidebar-meta,13px) leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </label>
            </div>
          );
        })}
        <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
          <input
            id="ask-user-question-other"
            type="checkbox"
            checked={otherChecked}
            disabled={inert}
            onChange={onToggleOther}
            aria-label="Other"
            className="mt-1 size-4 accent-primary"
          />
          <label
            htmlFor="ask-user-question-other"
            className="min-w-0 flex-1 cursor-pointer text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground"
          >
            Other
          </label>
          <input
            type="text"
            value={otherText}
            disabled={inert}
            onChange={(event) => onChangeOther(event.target.value)}
            placeholder="Type your own answer here"
            aria-label="Other answer"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-40"
          />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onSkip}
          disabled={inert}
          className="h-8 rounded-lg px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={inert || !(selected.length > 0 || otherText.trim().length > 0)}
          aria-label="Submit answer"
          className="flex h-8 items-center justify-center gap-1 rounded-lg bg-primary px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          Submit ⏎
        </button>
      </div>
      {error ? (
        <p aria-live="polite" className="px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ExtensionUISurface({
  requests,
  onRespond,
  onDismiss,
}: {
  requests: AgentUiRequest[];
  onRespond: (request: AgentUiRequest, value: string | boolean | null) => Promise<void>;
  onDismiss: (request: AgentUiRequest) => void;
}) {
  const request = requests.find((candidate) => candidate.expectsResponse) ?? requests.at(-1);
  if (!request) return null;
  if (!request.expectsResponse) {
    return (
      <div role="status" className="flex shrink-0 items-start gap-2 border-t border-border bg-muted/40 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px)">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{request.title ?? request.key ?? "Pi extension"}</span>
          {request.message ? <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{request.message}</p> : null}
          {request.lines?.length ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">{request.lines.join("\n")}</pre> : null}
        </div>
        <button type="button" onClick={() => onDismiss(request)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss extension notice">Dismiss</button>
      </div>
    );
  }
  return <ExtensionUIPrompt key={request.requestId} request={request} onRespond={onRespond} />;
}

function ExtensionUIPrompt({
  request,
  onRespond,
}: {
  request: AgentUiRequest;
  onRespond: (request: AgentUiRequest, value: string | boolean | null) => Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (response: string | boolean | null) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRespond(request, response);
    } catch (caught) {
      setError(String((caught as Error).message ?? caught));
    } finally {
      setPending(false);
    }
  };
  return (
    <section role="dialog" aria-label={request.title ?? "Pi extension request"} className="shrink-0 border-t border-primary/30 bg-primary/5 px-3 py-2">
      <p className="text-(length:--agent-panel-fs-sidebar-body,15px) font-medium">{request.title ?? "Pi extension request"}</p>
      {request.message ? <p className="mt-1 whitespace-pre-wrap text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">{request.message}</p> : null}
      {request.kind === "select" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options?.map((option) => (
            <button key={option} type="button" disabled={pending} onClick={() => void respond(option)} className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted disabled:opacity-40">{option}</button>
          ))}
          <button type="button" disabled={pending} onClick={() => void respond(null)} className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
        </div>
      ) : request.kind === "confirm" ? (
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={() => void respond(false)} className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
          <button type="button" disabled={pending} onClick={() => void respond(true)} className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Confirm</button>
        </div>
      ) : (
        <form className="mt-2 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void respond(value); }}>
          {request.kind === "editor" ? (
            <textarea autoFocus disabled={pending} rows={4} maxLength={50_000} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-primary disabled:opacity-40" />
          ) : (
            <input autoFocus disabled={pending} maxLength={50_000} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none focus:border-primary disabled:opacity-40" />
          )}
          <button type="button" disabled={pending} onClick={() => void respond(null)} className="h-9 rounded-lg px-2 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={pending} className="h-9 rounded-lg bg-primary px-3 text-primary-foreground disabled:opacity-40">Submit</button>
        </form>
      )}
      {error ? <p role="alert" className="mt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">{error}</p> : null}
    </section>
  );
}

/**
 * The terminal's open/close affordance, as one icon in the header.
 *
 * This replaces a permanent 45px footer band that spent a full row on a single
 * button. Progress and ready are carried by the icon itself and announced
 * through an off-screen live region, so those states now cost no layout at all;
 * failure and exit are the only states that still claim pixels, via
 * `TerminalNotice`, because those are the ones the viewer has to read.
 */
function TerminalControl({
  source,
  state,
  onOpen,
  onClose,
}: {
  source: "claude" | "codex";
  state: TerminalState;
  onOpen: () => void;
  onClose: () => void;
}) {
  const harness = harnessName(source);
  const busy = state.kind === "loading";
  const ready = state.kind === "ready";
  const label = ready ? `Close ${harness} terminal` : `Open ${harness} terminal`;
  const announcement =
    state.kind === "loading"
      ? `Opening ${harness}`
      : ready
        ? `${harness} terminal ready`
        : null;
  return (
    <>
      <button
        type="button"
        onClick={ready ? onClose : onOpen}
        disabled={busy}
        aria-label={label}
        title={label}
        className={
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-60 " +
          (ready
            ? "bg-primary/20 text-primary hover:bg-primary/30"
            : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")
        }
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <TerminalIcon className="h-4 w-4" aria-hidden />
        )}
      </button>
      {/* Announced, not drawn. The icon is the visual state; a sighted viewer
          reading a spinner does not also need a sentence about it. */}
      {announcement ? (
        <span role="status" className="sr-only">
          {announcement}
        </span>
      ) : null}
    </>
  );
}

/**
 * The only terminal states that get a visible row: the ones the viewer has to
 * act on. Everything else is announced by `TerminalControl` and costs no space.
 */
/**
 * Why the composer field is unavailable, in the panel's own words.
 *
 * The host sends fixed codes and this side owns the sentence, which is why the codes survive
 * translation and grep cleanly in host logs. An unrecognized code still says something true rather
 * than rendering an empty reason: a host newer than this panel may know states this build does not.
 */
function composerReasonText(reason: string | null): string {
  switch (reason) {
    case "not-running":
      return "No process is running this session, so no window owns it.";
    case "terminal-only":
      return "This session is running in a terminal, which has no window composer.";
    case "multiple-instances":
      return "This session is open in more than one Claude instance, so the host cannot tell which window to write into.";
    case "ambiguous-window":
      return "More than one open Codex window shows this session (likely a chat that has no first message yet). Open it in only one window, or send its first message, then try again.";
    case "no-window":
      return "This session's desktop app is running it but has no window for it.";
    case "ax-denied":
      return "The window composer needs Accessibility permission for the host.";
    case "composer-missing":
      return "The window exposed no prompt field to write into.";
    case "move-failed":
      return "The window could not be brought to this Desktop.";
    case "restore-failed":
      return "The window was brought to this Desktop and could not be sent back, so it is still here. Whatever you asked for most likely landed; move the window back by hand.";
    case "window-mover-unavailable":
      return "This macOS version does not expose the window mover needed for another Desktop.";
    case "write-failed":
      return "The composer refused the write.";
    case "verify-mismatch":
      return "The composer did not read back what was written.";
    case "question-missing":
      return "Claude's question panel isn't showing in the window right now.";
    case "placement-unavailable":
      return "The host cannot tell which Desktop the window is on.";
    case "focus-stolen":
      return "Another app took focus during the write, so it was abandoned.";
    case null:
      return "Unavailable.";
    default:
      return `Unavailable (${reason}).`;
  }
}

function TerminalNotice({
  source,
  state,
}: {
  source: "claude" | "codex";
  state: TerminalState;
}) {
  const harness = harnessName(source);
  if (state.kind === "error") {
    return (
      <div
        role="status"
        className="shrink-0 border-t border-border bg-destructive/10 px-3 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
      >
        {harness} terminal unavailable: {state.code}
      </div>
    );
  }
  if (state.kind === "ended") {
    return (
      <div
        role="status"
        className="shrink-0 border-t border-border px-3 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
      >
        {harness} terminal ended
      </div>
    );
  }
  return null;
}
