import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import {
  CornerDownLeft,
  List,
  LoaderCircle,
  Paperclip,
  Send,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type {
  AgentSessionDescriptor,
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentUiRequest,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import {
  type QuestionPanelStatus,
  WindowComposerError,
  type WindowComposerClient,
  type WindowComposerStatus,
  WindowQuestionError,
} from "@/features/window-composer/WindowComposerClient";
import type {
  AgentSessionControlState,
  EventMode,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import { SESSION_MEASURE_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { TokenMeter } from "@/features/activity-feed/TokenMeter";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import { BackgroundTasksPanel } from "@/features/background-tasks/BackgroundTasksPanel";
import { RunningTasksChip } from "@/features/background-tasks/RunningTasksChip";
import { useBackgroundTasks } from "@/features/background-tasks/useBackgroundTasks";
import { useSessionCommands } from "@/features/session-view/useSessionCommands";
import { usePanelCommands } from "@/features/session-view/usePanelCommands";
import { SummaryBand } from "@/features/summary/SummaryBand";
import { SummaryControl } from "@/features/summary/SummaryControl";
import { useSummary } from "@/features/summary/useSummary";
import { cliInputReasonText, useCliInput, type CliInputHandle } from "@/features/cli-input/useCliInput";
import {
  tmuxComposerReasonText,
  useTmuxComposer,
  type ComposerImage,
} from "@/features/cli-input/useTmuxComposer";
import { ComposerImageStrip } from "@/features/cli-input/ComposerImageStrip";
import { ComposerCommandList } from "@/features/cli-input/ComposerCommandList";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import type { ModifierState } from "@/features/keyboard/modifierLatch";
import type { ComposerCommand, RailKey, RailModifier } from "@agentdesk/agent-feed-wire";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import type { AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import { terminalContextKey } from "@/features/terminal/terminalContext";
import { useSessionComposerPane } from "@/features/session-view/useSessionComposerPane";
import { SessionComposer } from "@/features/session-view/composer/SessionComposer";
import { ExtensionUISurface } from "@/features/session-view/SessionExtensionUI";
import { TerminalControl, TerminalNotice } from "@/features/session-view/SessionTerminalControls";
import type {
  AgentTerminalComposer,
  SessionViewContext,
  TerminalState,
} from "@/features/session-view/sessionTerminalTypes";

// Re-exported: the app and the canvas both hand a session view its context by this name.
export type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";

/**
 * One session, whole: its transcript, its controls, and every band that acts on it.
 *
 * This used to be the shell's own body -- a `<main>` holding the feed, with the summary band, the
 * tasks chip, the composer, the terminal notice and the terminal pane as its siblings in the app's
 * flex column, all of them reading a dozen pieces of state the shell held one copy of. That shape
 * can only ever show one session, in one place: the app.
 *
 * The reason it is a component now is HEIGHT. It states none of its own -- the root is a flex
 * column, the transcript is `min-h-0 flex-1`, every band under it is `shrink-0` -- so it is the
 * whole page when something gives it the whole page, and it is a box in a list when something
 * gives it a box in a list. `ActivityFeed` has always worked this way (`h-full` over its own
 * scroller), which is why a transcript already renders inside a Bot card; this extends the same
 * property to everything below the transcript.
 *
 * The safe-area insets are therefore NOT in here and must not move in: they describe the page's
 * physical edges rather than this box.
 *
 * Everything inside it measures this column rather than the viewport, which is what makes the
 * paragraph above true rather than aspirational: `SummaryBand` caps at a share of it, the thread's
 * terminal takes a share of it by being its child, and the composer's terminal is handed it
 * explicitly because a band pane has no parent to measure. It is capped and centred rather than
 * filling whatever box it is given, so a wide window shows a measure (`SESSION_MEASURE_CLASS`).
 *
 * Everything per-session is owned here and reset by REMOUNTING, so the owner keys this on the
 * session. The mode toggle deliberately does not remount it: only the feed inside is keyed on the
 * mode, because every event index the feed holds is counted in the mode it was read in, while a
 * draft and an open terminal are not.
 */
export function SessionView({
  feed,
  host,
  projectPath,
  session,
  eventMode,
  onToggleEventMode,
  showCacheHits,
  onToggleCacheHits,
  controlsHost,
  windowComposers,
  compact,
  tasksHost,
  onAcceptFiles,
  onForkFromMessage,
  onAttachSession,
  externalError = null,
  terminalPaneShownByDefault = false,
}: SessionViewContext & {
  /** The directory this session runs in, which is how its terminal names the process to open. */
  projectPath: string;
  session: SessionSummary;
  /**
   * Where this session's controls render, or null to render none.
   *
   * A portal rather than a band, because the controls belong in whatever titlebar the surface
   * already has -- the app's header, or a card's own row. The feed's controls go through the same
   * mechanism, into a node rendered INSIDE this strip: two components portalling into one host
   * would order themselves by whichever mounted first, and the feed's controls belong left of
   * these.
   */
  controlsHost: HTMLElement | null;
  /**
   * Takes this session's image-accepting function, or null while it has none.
   *
   * Required rather than optional: every surface that mounts a session owns a box a reader can
   * aim a file at, and one that quietly took no callback would be one where dropping a file is
   * the browser's business instead of the panel's.
   *
   * MUST be stable across renders -- a state setter, or a `useCallback` with no changing
   * dependency. It is a dependency of the effect that publishes, so a fresh function each render
   * would republish on every keystroke in the composer, and the null on its cleanup would blink
   * the surface's overlay to a refusal mid-drag.
   */
  onAcceptFiles: (accept: ((files: readonly File[]) => void) | null) => void;
  /**
   * The bound half of the context's `attachSessionToBot`: takes a session `/new` or `/fork` just
   * made and puts it on the Bot this card belongs to. Absent on a surface with no canvas behind
   * the session, and the command then says where the session went rather than appearing to do
   * nothing.
   */
  onAttachSession?: (session: AgentSessionDescriptor) => void | Promise<void>;
  /**
   * An error raised outside this session's own commands -- a Bot edit, say -- shown on the same
   * band, because it has no band of its own and a failure that shows nowhere is indistinguishable
   * from a success.
   */
  externalError?: string | null;
  /**
   * Shows the session's own pane above the composer until the reader hides it, rather than only
   * once they show it. For a surface whose sessions live in panes the reader is there to type in,
   * such as an arena lane; the composer's terminal control still hides and shows it.
   */
  terminalPaneShownByDefault?: boolean;
}) {
  const { source, sessionId, capabilities } = session;
  /**
   * The message fork, bound to this session, or undefined when it cannot be offered.
   *
   * Claude only, decided here rather than in the row: `--fork-session` is a Claude CLI flag, and
   * Codex's `resume` has no fork, so a Codex source would be silently resumed into the transcript
   * it was supposed to branch away from. The row's own test is a different one -- whether a person
   * wrote that line -- and neither can stand in for the other.
   */
  const forkFromMessage = useMemo(
    () => (onForkFromMessage === undefined || source !== "claude"
      ? undefined
      : (message: { eventId: string; text: string }) =>
        onForkFromMessage({ session, projectPath, message })),
    [onForkFromMessage, projectPath, session, source],
  );
  const [terminal, setTerminal] = useState<TerminalState>({ kind: "idle" });
  const commands = useSessionCommands(feed, session);
  /**
   * The slash commands the panel runs itself -- `/model`, `/new`, `/fork`, `/export`, `/btw` --
   * and the dialogs two of them open. It owns the models dialog's filter rather than this file
   * holding the state, because the routing and the dialog are one thing: a filter set by
   * `/model opus` and one set by the footer's model button are the same door.
   */
  const panelCommands = usePanelCommands({
    commands,
    feed,
    sessionId,
    projectPath,
    // A prop rather than the context's factory: the card binds its own Bot before handing this
    // over, and a surface with no canvas behind the session leaves it out.
    ...(onAttachSession === undefined ? {} : { onAttachSession }),
  });
  const [sessionState, setSessionState] = useState<AgentSessionControlState>({
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
  });
  // Mirrored up from ActivityFeed, which owns the event stream both derive from, and rendered by
  // the composer band below the transcript.
  const [sessionUsage, setSessionUsage] = useState<TokenUsage | null>(null);
  // The switcher label, mirrored beside usage rather than derived from it: usage blanks across
  // a post-compaction gap while the model survives it.
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [openQuestion, setOpenQuestion] = useState<OpenAskUserQuestion | null>(null);
  const [extensionUI, setExtensionUI] = useState<AgentUiRequest[]>([]);
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  // Held in state, not a ref, because the feed has to re-render once the node exists.
  const [feedControlsHost, setFeedControlsHost] = useState<HTMLDivElement | null>(null);
  // This column is what the composer's terminal takes its height as a share of. A band pane cannot
  // measure its own parent -- it IS the band -- so without this it asks the viewport, which is the
  // right answer only while this view is the page. State rather than a ref, because the pane has to
  // render again once the node exists; a ref would still be null when its own effects ran.
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  /**
   * What takes an image dropped on this session, or null while nothing here can hold one.
   *
   * Published upward by the band rather than reached down for, because only the band knows whether
   * there is a box to put an image in; see `onFileDrop` there. Held here first, in a state setter
   * that is stable by construction, so the band's effect does not re-run on every render of
   * whoever mounted this view.
   *
   * Wrapped in an object because `setFileDrop` would take a bare function as an updater and call
   * it rather than store it.
   */
  const [fileDrop, setFileDrop] = useState<{ accept: (files: readonly File[]) => void } | null>(
    null,
  );
  /**
   * Hands it on to the surface, which is what actually owns the box a reader aims at.
   *
   * This view is not that box. On the canvas it is the card's BODY, mounted only while the card is
   * open and sitting below the titlebar that carries the session's name -- so a file aimed at the
   * name, or at a collapsed card, would never reach a handler installed here. Same reasoning as
   * `controlsHost`: what this view knows, the surface places.
   */
  useEffect(() => {
    onAcceptFiles(fileDrop?.accept ?? null);
    return () => onAcceptFiles(null);
  }, [onAcceptFiles, fileDrop]);

  const summary = useSummary(feed, { source, sessionId });
  // Whether this is a Claude Code process in someone's terminal, which is what decides between the
  // window composer and a plain send. Asked only for claude rows; every other source leaves the
  // hook inert and never issues a request.
  const cliInput = useCliInput(feed, { source, sessionId }, source === "claude");
  const composerPane = useSessionComposerPane(source, sessionId, terminalPaneShownByDefault);

  const terminalComposer = useMemo<AgentTerminalComposer | null>(() => {
    if (terminal.kind !== "ready") return null;
    return {
      send: (text) => feed.sendTerminalPrompt(terminal.descriptor.terminalId, text),
    };
  }, [feed, terminal]);

  // Addresses this session for the task stream. `mode` is required by the reference type but means
  // nothing here -- background tasks are not read in a transcript view -- so it is pinned rather
  // than threaded through, which would invite it to matter.
  const taskSession = useMemo(
    () => ({ source, sessionId, mode: "nice" as const }),
    [source, sessionId],
  );
  const backgroundTasks = useBackgroundTasks(feed, taskSession);

  // Extension-UI prompts arrive on the open thread's own stream, so they need no session filter
  // here and cannot outlive the thread that asked them: this view is keyed on the session, so
  // leaving one unmounts the subscription along with whatever was still on screen.
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

  const openTerminal = useCallback(() => {
    if (!isTerminalSource(source) || !capabilities.canOpenTerminal) return;
    setTerminal({
      kind: "loading",
      context: { kind: "agent-session", projectPath, source, sessionId },
    });
  }, [capabilities.canOpenTerminal, projectPath, sessionId, source]);

  const closeTerminal = useCallback(() => {
    setTerminal((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, []);

  const updateTerminalState = useCallback(
    (context: AgentTerminalContext, state: AgentTerminalState) => {
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
    },
    [],
  );

  const tasksPanel = tasksPanelOpen ? (
    <BackgroundTasksPanel
      compact={compact}
      snapshot={backgroundTasks}
      source={feed}
      session={taskSession}
      onClose={() => setTasksPanelOpen(false)}
    />
  ) : null;
  /**
   * Where that panel lands, which the compact branch answers differently from the wide one.
   *
   * `fixed inset-0` means the viewport until an ancestor carries a transform, a filter or a
   * containment, any of which silently becomes its containing block instead. A canvas card is not
   * the viewport, so the compact sheet goes to the body, which is what its own positioning already
   * claims. Nothing moves today; the canvas's zoom mode is about to put a transform there, on a
   * phone, where every open card renders this sheet. The wide branch is `absolute` against the
   * card and stays in it, one host per session (`BotSessionCard`).
   */
  const tasksTarget = compact ? globalThis.document?.body ?? null : tasksHost;

  return (
    // The transcript does NOT read `feed` from this component -- `useSessionEventsStream` and the
    // system blocks below it take their data source from React context -- so the two have to be
    // made the same thing here or they quietly disagree. They did: a Bot on another machine got its
    // commands from its own sidecar and its transcript from the app's, which answered "session not
    // found" for a session that was never on it. The card rendered, said 404, and looked like a
    // broken peer rather than a misrouted read. Providing it here means the prop is the context
    // everywhere this component is mounted, rather than everywhere someone remembered.
    //
    // A no-op on the thread view, where the source given is already the one above.
    <DataSourceProvider source={feed}>
    {/* `session-view-surface` rather than `bg-card`, and the transcript's ground below likewise.
        Both resolve to the token they name unless something above them published a colour, which
        only a Bot card's shaded session does (`styles.css`, `.bot-session-fill`). Putting the
        utility back would repaint an open session plain over the top of the colour that says which
        session it is, which is the bug these replaced. */}
    <div ref={setColumn} className={`${SESSION_MEASURE_CLASS} flex h-full min-h-0 flex-col session-view-surface`}>
      {controlsHost
        ? createPortal(
          <>
            <div ref={setFeedControlsHost} className="flex shrink-0 items-center" />
            {summary.available ? (
              <SummaryControl
                state={summary.state}
                running={sessionState.runState === "running"}
                onSummarize={summary.summarize}
              />
            ) : null}
            {capabilities.canOpenTerminal && isTerminalSource(source) ? (
              <TerminalControl
                source={source}
                state={terminal}
                onOpen={openTerminal}
                onClose={closeTerminal}
              />
            ) : null}
          </>,
          controlsHost,
        )
        : null}
      {/* ActivityFeed remains the thread's only scroll owner: the bands below it are outside its
          box, so sticky transcript headers and virtualization read the same scrollTop whether this
          view is the whole page or a card. */}
      <div key={`${sessionId}:${eventMode}`} className="min-h-0 flex-1 overflow-hidden session-view-ground">
        <ActivityFeed
          source={source}
          sessionId={sessionId}
          mode={eventMode}
          onToggleMode={onToggleEventMode}
          canToggleMode={capabilities.modes.length > 1}
          showCacheHits={showCacheHits}
          onToggleCacheHits={onToggleCacheHits}
          controlsHost={feedControlsHost}
          onSessionState={setSessionState}
          onUsage={setSessionUsage}
          onSessionModel={setSessionModel}
          onOpenQuestion={setOpenQuestion}
          {...(forkFromMessage === undefined ? {} : { onForkFromMessage: forkFromMessage })}
        />
      </div>
      {capabilities.supportsExtensionUi ? (
        <ExtensionUISurface
          requests={extensionUI}
          onRespond={async (request, value) => {
            await commands.respondToExtensionUI(request.requestId, value);
          }}
          onDismiss={(request) =>
            setExtensionUI((current) => current.filter((item) => item.requestId !== request.requestId))}
        />
      ) : null}
      {/* Above the composer, below the transcript. Not rows in the feed: ActivityFeed is the
          thread's only scroll owner and synthetic rows would fight its tail-follow. */}
      <SummaryBand state={summary.state} model={summary.model} onDismiss={summary.dismiss} />
      <RunningTasksChip
        count={backgroundTasks.running.length}
        open={tasksPanelOpen}
        onToggle={() => setTasksPanelOpen((open) => !open)}
      />
      {/* One composer band for every source. The UI is shared code; the send mechanism is
          selected explicitly: native window, CLI inbox, then an already-open Agent Feed pty; Pi
          reaches its harness. The context meter lives here, below the action row, instead of in
          the header. */}
      <SessionComposer
        host={host}
        feed={feed}
        session={session}
        state={sessionState}
        usage={sessionUsage}
        sessionModel={sessionModel}
        pending={commands.commandPending}
        error={commands.commandError ?? externalError}
        question={openQuestion}
        cliInput={cliInput}
        windowComposerClient={source === "codex" ? windowComposers.codex : windowComposers.claude}
        agentTerminal={terminalComposer}
        terminalComposer={composerPane}
        terminalHeightBasis={column}
        onFileDrop={setFileDrop}
        onSendMessage={commands.sendPrompt}
        onRunSlash={panelCommands.run}
        surfaces={panelCommands.surfaces}
        onAbort={commands.abortRun}
      />
      {isTerminalSource(source) ? <TerminalNotice source={source} state={terminal} /> : null}
      {terminal.kind === "loading" || terminal.kind === "ready" ? (
        <AgentTerminalPane feed={feed} context={terminal.context} onState={updateTerminalState} />
      ) : null}
      {tasksPanel && tasksTarget ? createPortal(tasksPanel, tasksTarget) : tasksPanel}
    </div>
    </DataSourceProvider>
  );
}

export function isTerminalSource(source: string): source is "claude" | "codex" | "opencode" {
  return source === "claude" || source === "codex" || source === "opencode";
}

export function harnessName(source: "claude" | "codex" | "opencode"): string {
  return source === "claude" ? "Claude" : source === "codex" ? "Codex" : "Opencode";
}
