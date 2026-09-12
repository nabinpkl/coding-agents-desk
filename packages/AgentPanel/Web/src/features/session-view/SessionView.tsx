import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, List, LoaderCircle, Send, Square, Terminal as TerminalIcon, X } from "lucide-react";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentUiRequest,
  SessionSummary,
  SessionTmuxTerminalContext,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "../activity-feed/data-source/HostActionsClient";
import {
  type QuestionPanelStatus,
  WindowComposerError,
  type WindowComposerClient,
  type WindowComposerStatus,
  WindowQuestionError,
} from "../window-composer/WindowComposerClient";
import type {
  AgentSessionControlState,
  EventMode,
} from "../activity-feed/data-source/AgentDataSource";
import { ActivityFeed } from "../activity-feed/ActivityFeed";
import { TokenMeter } from "../activity-feed/TokenMeter";
import type { TokenUsage } from "../activity-feed/useSessionEventsStream";
import { BackgroundTasksPanel } from "../background-tasks/BackgroundTasksPanel";
import { RunningTasksChip } from "../background-tasks/RunningTasksChip";
import { useBackgroundTasks } from "../background-tasks/useBackgroundTasks";
import { SummaryBand } from "../summary/SummaryBand";
import { SummaryControl } from "../summary/SummaryControl";
import { useSummary } from "../summary/useSummary";
import { cliInputReasonText, useCliInput, type CliInputHandle } from "../cli-input/useCliInput";
import {
  tmuxComposerReasonText,
  useTmuxComposer,
  type ComposerImage,
} from "../cli-input/useTmuxComposer";
import type { OpenAskUserQuestion } from "../../app/askUserQuestion";
import { AgentTerminalPane } from "../terminal/AgentTerminalPane";
import type { AgentTerminalState } from "../terminal/useAgentTerminal";
import { terminalContextKey } from "../terminal/terminalContext";
import {
  toggleTerminalComposer,
  useTerminalComposerShown,
} from "../terminal/terminalComposerPreference";

type TerminalState =
  | { kind: "idle" }
  | { kind: "loading"; context: AgentTerminalContext }
  | { kind: "ready"; context: AgentTerminalContext; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; context: AgentTerminalContext; code: string }
  | { kind: "ended"; context: AgentTerminalContext; exitStatus?: number };

interface AgentTerminalComposer {
  send: (text: string) => Promise<void>;
}

/**
 * Everything a `SessionView` needs that is not the session itself.
 *
 * One object because it is identical for every session on a surface: a Bot canvas hands the same
 * one to whichever row it has open, and the shell builds all of it once. Split out so a surface
 * that renders sessions can take "the context" as a single prop instead of restating nine.
 */
export interface SessionViewContext {
  feed: SidecarDataSource;
  host: HostActionsClient;
  /**
   * Raw or nice, and the toggle for it. Owned by whoever mounts this rather than in here, because
   * it is a reader's preference that outlives any one session and is persisted as such.
   */
  eventMode: EventMode;
  onToggleEventMode: () => void;
  showCacheHits: boolean;
  onToggleCacheHits: () => void;
  /**
   * One client per source, built by the owner. They are bound to a source rather than a session --
   * Claude resolves its window by process tree, Codex by its accessibility tree -- so they are
   * shared across every session rather than rebuilt per view.
   */
  windowComposers: { claude: WindowComposerClient; codex: WindowComposerClient };
  /** Whether the tasks panel should present as a sheet rather than a column beside the thread. */
  compact: boolean;
  /**
   * Where the background-tasks panel renders, or null to render it in place.
   *
   * It is the one thing here that is not part of the column: it floats over the thread, positioned
   * against the app's own relative root. A host keeps that true without this component having to
   * know what it is layered over.
   */
  tasksHost: HTMLElement | null;
}

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
 * explicitly because a band pane has no parent to measure.
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
  externalError = null,
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
   * An error raised outside this session's own commands -- a Bot edit, say -- shown on the same
   * band, because it has no band of its own and a failure that shows nowhere is indistinguishable
   * from a success.
   */
  externalError?: string | null;
}) {
  const { source, sessionId, capabilities } = session;
  const [terminal, setTerminal] = useState<TerminalState>({ kind: "idle" });
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<AgentSessionControlState>({
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
  });
  // Mirrored up from ActivityFeed, which owns the event stream both derive from, and rendered by
  // the composer band below the transcript.
  const [sessionUsage, setSessionUsage] = useState<TokenUsage | null>(null);
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

  const summary = useSummary(feed, { source, sessionId });
  // Whether this is a Claude Code process in someone's terminal, which is what decides between the
  // window composer and a plain send. Asked only for claude rows; every other source leaves the
  // hook inert and never issues a request.
  const cliInput = useCliInput(feed, { source, sessionId }, source === "claude");
  const terminalComposerShown = useTerminalComposerShown();

  const terminalComposer = useMemo<AgentTerminalComposer | null>(() => {
    if (terminal.kind !== "ready") return null;
    return {
      send: (text) => feed.sendTerminalPrompt(terminal.descriptor.terminalId, text),
    };
  }, [feed, terminal]);

  // The composer's terminal names the SESSION, and the sidecar resolves which tmux pane that is:
  // the one a live process is running in, or one it starts to resume the session id.
  //
  // It used to name the pane instead, read from `cliInput.tmuxSession`, and that could only ever
  // be half the sessions: the value comes from a live process's registry row, so a session running
  // outside tmux and a session not running at all both read as null and got no terminal. It also
  // had to be latched, because `cliInput` resets to idle on every status read and a terminal
  // mounted on the live value was torn down and re-attached every couple of seconds -- measured as
  // a close/open cycle in the network log. Naming the session removes both: the id is stable for
  // as long as this view is mounted, and nothing about it blinks.
  const composerTerminal = useMemo<SessionTmuxTerminalContext | null>(
    () =>
      source === "claude" || source === "codex"
        ? { kind: "session-tmux", source, sessionId }
        : null,
    [source, sessionId],
  );

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

  const sendPrompt = useCallback(async (text: string, delivery: "next" | "steer") => {
    if (commandPending || !text.trim()) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.sendMessage(session, text.trim(), delivery);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
      // Rethrow so the composer that owns the draft only clears it on success.
      throw error;
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  const abortRun = useCallback(async () => {
    if (commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await feed.abortSession(session);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
    } finally {
      setCommandPending(false);
    }
  }, [commandPending, feed, session]);

  const tasksPanel = tasksPanelOpen ? (
    <BackgroundTasksPanel
      compact={compact}
      snapshot={backgroundTasks}
      source={feed}
      session={taskSession}
      onClose={() => setTasksPanelOpen(false)}
    />
  ) : null;

  return (
    <div ref={setColumn} className="flex h-full min-h-0 flex-col bg-card">
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
      <div key={`${sessionId}:${eventMode}`} className="min-h-0 flex-1 overflow-hidden bg-background">
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
          onOpenQuestion={setOpenQuestion}
        />
      </div>
      {capabilities.supportsExtensionUi ? (
        <ExtensionUISurface
          requests={extensionUI}
          onRespond={async (request, value) => {
            setCommandError(null);
            try {
              await feed.respondToExtensionUI(session, request.requestId, value);
            } catch (error) {
              setCommandError(String((error as Error).message ?? error));
              throw error;
            }
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
        pending={commandPending}
        error={commandError ?? externalError}
        question={openQuestion}
        cliInput={cliInput}
        windowComposerClient={source === "codex" ? windowComposers.codex : windowComposers.claude}
        agentTerminal={terminalComposer}
        terminalComposer={composerTerminal
          ? {
            context: composerTerminal,
            shown: terminalComposerShown,
            toggle: toggleTerminalComposer,
          }
          : null}
        terminalHeightBasis={column}
        onSendMessage={sendPrompt}
        onAbort={abortRun}
      />
      {isTerminalSource(source) ? <TerminalNotice source={source} state={terminal} /> : null}
      {terminal.kind === "loading" || terminal.kind === "ready" ? (
        <AgentTerminalPane feed={feed} context={terminal.context} onState={updateTerminalState} />
      ) : null}
      {tasksPanel && tasksHost ? createPortal(tasksPanel, tasksHost) : tasksPanel}
    </div>
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
  terminalComposer,
  terminalHeightBasis,
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
   * This session's own terminal, and whether to show it.
   *
   * A context rather than a pane name: which pane it is -- the session's live one, or one started
   * to resume it -- is resolved when the terminal opens, by the side that can see tmux. Null for a
   * source with no CLI to resume, which is when there is nothing to show and no switch to offer.
   */
  terminalComposer: {
    context: SessionTmuxTerminalContext;
    shown: boolean;
    toggle: () => void;
  } | null;
  /**
   * What this band's terminal takes its height as a share of, and whether it renders at all: the
   * pane waits for it rather than mounting against the viewport for a render and re-fitting itself
   * once the real reference arrives.
   */
  terminalHeightBasis: HTMLElement | null;
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

  // The same session's own prompt box, mirrored while it is running in a tmux pane.
  //
  // Asked for every Claude session rather than only for `inboxCandidate` ones, and that is not
  // caution -- it is the difference between this working and never appearing. `entrypoint` says
  // how a session was LAUNCHED, and every live tmux session on this machine reports
  // `claude-desktop` because they were forked from Remote Control: measured, all ten of them.
  // Whether there is a box to mirror is a different question, and the sidecar answers it by
  // looking for the pane. Codex is left out because the box this reads is Claude's TUI's, which
  // is also why the route refuses any other source.
  //
  // The address is stable because the hook keys its poll and its draft on it, and a fresh object
  // every render would restart both on every status the Feed reads.
  const tmuxComposerSession = useMemo(() => ({ source, sessionId }), [source, sessionId]);
  const tmuxComposer = useTmuxComposer(feed, tmuxComposerSession, isClaude);

  // Delivery priority is one explicit state, not several independent availability flags.
  //
  // A live tmux pane owns composition FIRST, ahead of the native window it may also be visible in.
  // That ordering is deliberate and it is a change: where both exist, the pane is where the CLI
  // actually is and the window is a Remote Control view OF that pane, so writing the window's
  // accessibility field is one indirection further from the process than typing at its keyboard.
  // It is also the only one of the two that is two-way -- what somebody types in the terminal
  // shows up here, which an AX write cannot give.
  //
  // A native window owns it next, for a session that has no pane. A Claude CLI inbox after that,
  // for one running outside tmux, where there is no box to read. Only a KNOWN native refusal or
  // an unavailable inbox may fall through to the Agent Feed pty, and only while that pty is
  // already open. Opening a process remains an explicit action in the terminal control.
  const transport:
    | { kind: "window" }
    | { kind: "tmux-composer" }
    | { kind: "cli-inbox" }
    | { kind: "agent-terminal"; terminal: AgentTerminalComposer }
    | { kind: "agent-session" } = tmuxComposer.mirrored
      ? { kind: "tmux-composer" }
      : inboxCandidate
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
  const tmuxBand = transport.kind === "tmux-composer";
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
  // The composer's terminal reports its state like any other, and there is nothing here to do
  // with it: the pane renders its own errors in its footer. Stable so the pane is not restarted by
  // a re-render of this band, which happens on every status the Feed reads.
  const noteTerminalState = useCallback(() => {}, []);

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
  /**
   * Whether files are being dragged over the field right now.
   *
   * Only for the ring. A drop target with no visible edge is one nobody discovers, and the browser
   * gives no hint of its own -- the cursor says "you may drop" over the whole page.
   */
  const [dragging, setDragging] = useState(false);
  const previousTransport = useRef(transport.kind);
  useEffect(() => {
    if (previousTransport.current === "window" && transport.kind !== "window") {
      setLocalDraft((current) => current.length > 0 ? current : windowComposer.draft);
      windowComposer.stopWatching();
    }
    // The mirror answers a request behind the band it replaces, so for the moment before its
    // first read this session composes locally. Anything typed in that moment moves across with
    // it rather than being dropped when the field changes owner.
    if (previousTransport.current !== "tmux-composer" && transport.kind === "tmux-composer") {
      // Either side may be holding it: a window session whose pane has just been found hands its
      // draft over through `localDraft` in the branch above, and that `setLocalDraft` has not
      // landed by the time this branch runs on the same pass.
      const carried = localDraft.length > 0 ? localDraft : windowComposer.draft;
      if (carried.length > 0 && tmuxComposer.draft.length === 0) tmuxComposer.change(carried);
      setLocalDraft("");
    }
    previousTransport.current = transport.kind;
  }, [
    localDraft,
    transport.kind,
    tmuxComposer.change,
    tmuxComposer.draft,
    windowComposer.draft,
    windowComposer.stopWatching,
  ]);
  // The two mirrored transports own their own draft, because it is half of a value something
  // outside this component holds the other half of. Everything else composes locally.
  const editorValue = windowBand
    ? windowComposer.draft
    : tmuxBand
      ? tmuxComposer.draft
      : localDraft;
  const autoGrow = useAutoGrowingTextArea(editorValue);

  // The terminal when it is the band's input surface, null when the field is. One name rather than
  // the condition written twice, because the whole point is that they are never both on screen.
  const terminalInput = terminalComposer?.shown && terminalHeightBasis ? terminalComposer : null;

  const [deliveryPending, setDeliveryPending] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const piUnavailable = !isClaude && !isCodex && !capabilities.canSend;
  const unavailable = windowBand || tmuxBand
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
    /**
     * What Tab does instead of moving focus, when there is something to accept.
     *
     * Only the mirrored terminal band has one: it is the only field whose placeholder is a real
     * offer from the other side rather than a label. Absent everywhere else, so Tab keeps moving
     * focus, which is what a keyboard reader expects of it.
     */
    onAcceptHint?: () => void;
    /**
     * What files arriving at the field do, where that means something.
     *
     * Dropped and pasted alike: they are the same arrival, and a phone has no drag at all, so the
     * two share one handler rather than one being the real path and the other a shortcut to it.
     * Only the mirrored terminal band has one, because it is the only field whose other end can
     * hold an image; absent elsewhere, so a drop there does whatever the browser would have done.
     */
    onFiles?: (files: readonly File[]) => void;
    /** The images the composer is holding, shown above the text the way the box holds them. */
    images?: readonly ComposerImage[];
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
    : tmuxBand
    ? {
        // The draft lives in the hook, not in `localDraft`, because it is not local: it is one
        // half of a value the pane holds the other half of, and the hook is what keeps the two
        // agreeing in both directions.
        value: tmuxComposer.draft,
        onChange: tmuxComposer.change,
        disabled: tmuxComposer.pending,
        ariaLabel: "Type into this session's terminal composer",
        // Claude's own suggestion when it is offering one, shown where the terminal shows it and
        // as what it is: a placeholder, which takes no part in the value and is never pushed.
        // Tab accepts it, the same key that accepts it in the pane.
        placeholder: tmuxComposer.hint ?? "Type into Claude's terminal\u2026",
        // A coarse guard rather than the sidecar's own limit restated: that one counts BYTES and
        // this counts UTF-16 units, so they are not the same quantity and cannot be. The number
        // is the sidecar's, which is smaller than a turn sent once because this text is retyped
        // whenever a guess about the box misses. Exceeding it is refused there, with a reason.
        maxLength: 16 * 1024,
        sendOnEnter: true,
        // No `onFocus`: the stream behind this field is already current, where the bands either
        // side of it re-read something at the moment somebody is about to act on it.
        onBlur: tmuxComposer.onBlur,
        ...(tmuxComposer.hint === null
          ? {}
          : { onAcceptHint: () => void tmuxComposer.accept() }),
        onFiles: (files) => void tmuxComposer.drop(files),
        images: tmuxComposer.images,
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
    // Return in the pane, not a delivery: the composer already holds the text, because every
    // keystroke put it there. `submit` on the hook flushes anything still inside the debounce
    // first, so Enter never presses half a sentence.
    if (tmuxBand) {
      if (!editorValue.trim()) return;
      return await tmuxComposer.submit();
    }
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
  } else if (tmuxBand) {
    // One action, like the bands below it and for the same reason: Steer and Stop act on a queue
    // the panel owns, and this session owns its own.
    actions.push({
      key: "send-tmux-composer",
      ariaLabel: "Send in this session's terminal",
      title: "Press Return in this session's terminal, sending what its composer holds",
      icon: tmuxComposer.pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        <CornerDownLeft className="size-4" aria-hidden />
      ),
      disabled: tmuxComposer.pending || !editorValue.trim(),
      className:
        "flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40",
      onClick: () => void tmuxComposer.submit(),
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
  } else if (tmuxBand) {
    // This band latches, so a reason here is a pane that WAS being mirrored and now cannot be
    // reached: a redraw between frames, or a session that exited under the field. Same precedence
    // as the inbox next door -- the reason outranks a request's own error, because "that session
    // is gone" explains the failure where a request that had nowhere to go does not.
    caption = tmuxComposer.reason
      ? tmuxComposerReasonText(tmuxComposer.reason)
      : tmuxComposer.error
        // Said out loud because this reader has no terminal footer to learn it from. The offer is
        // in the placeholder and the key that takes it is not visible anywhere else.
        ?? (tmuxComposer.hint === null
          ? "Typing into this session's own terminal."
          : "Tab takes Claude's suggestion.");
    captionIsError = tmuxComposer.reason != null || tmuxComposer.error != null;
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

  const sectionLabel = tmuxBand
    ? "Terminal session composer, mirrored"
    : inboxBand
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
      {/* The session's own terminal, INSTEAD of the field rather than above it.

          Both are ways of typing at the same session -- the field sends a turn through the harness,
          the terminal types into the process -- and which one you want changes between asking it
          something and answering its own prompt. But wanting both at once is not a thing that
          happens, and showing both spent two thirds of the band on input while the transcript they
          are about went to a sliver. So the button below switches between them and the transcript
          keeps the difference.

          Keyed by the pane so switching sessions tears the old attach down rather than repointing a
          live one, and scrolling rather than resizing, because the terminal renders at the pane's
          own geometry -- imposing a size here would reflow the session in whatever terminal its
          owner has it open in. */}
      {terminalInput ? (
        // `AgentTerminalPane` rather than a tile: it is the same hook underneath and it already
        // owns the resize handle, the header and the footer. It takes a tmux context as readily as
        // an agent-session one, so the composer needed no second copy of any of that.
        //
        // Its `band` layout, so the pane's height IS the band's height: nothing reserves a box
        // around it to leave blank, and a drag upward makes the whole band taller rather than
        // growing the pane down into reserved space. A share of the session's column rather than
        // of the viewport, because the session is not always the page.
        <div className="mb-2">
          <AgentTerminalPane
            key={terminalContextKey(terminalInput.context)}
            feed={feed}
            context={terminalInput.context}
            onState={noteTerminalState}
            layout="band"
            heightBasis={terminalHeightBasis}
          />
        </div>
      ) : null}
      <div className={`flex items-end gap-1.5 ${terminalInput ? "justify-end" : ""}`}>
        {terminalInput ? null : <div
          // The box is this wrapper rather than the field, so the images sit INSIDE it, above the
          // text, the way the composer they are mirroring holds them. The field keeps its own
          // scrolling and auto-grow and gives up only its border.
          className={`flex min-w-0 flex-1 flex-col rounded-xl border bg-background shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25 ${
            dragging ? "border-primary ring-2 ring-primary/25" : "border-border"
          } ${editor.disabled ? "opacity-40" : ""}`}
          // Offered only where the other end can hold an image, so these are absent rather than
          // inert on the other bands: without `onDragOver` preventing the default, no drop event
          // fires at all and the browser navigates to the file instead. On the wrapper rather than
          // the field so the images are a drop target too.
          {...(editor.onFiles === undefined ? {} : {
            onDragOver: (event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            },
            // Only when the pointer has actually left the box. `dragleave` also fires when it
            // crosses onto a child -- the images, the field -- and dropping the ring there makes
            // it flicker over exactly the area somebody is aiming at.
            onDragLeave: (event: DragEvent<HTMLDivElement>) => {
              const to = event.relatedTarget;
              if (to instanceof Node && event.currentTarget.contains(to)) return;
              setDragging(false);
            },
            onDrop: (event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setDragging(false);
              editor.onFiles?.([...event.dataTransfer.files]);
            },
          })}
        >
          {editor.images && editor.images.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 px-3 pt-3">
              {editor.images.map((image) => (
                <li key={image.id}>
                  {image.url === null ? (
                    // An image this panel never sent -- dropped into the pane by whoever is
                    // sitting there. Named rather than hidden, so the strip and the text agree.
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-muted/40 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
                      title={`Image #${image.id}, dropped into the terminal`}
                    >
                      {`#${image.id}`}
                    </span>
                  ) : (
                    <img
                      src={image.url}
                      alt={`Image #${image.id} in the composer`}
                      className="h-11 w-11 rounded-md border border-border object-cover"
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
          ref={autoGrow}
          value={editor.value}
          onChange={(event) => editor.onChange(event.target.value)}
          onFocus={editor.onFocus}
          onBlur={editor.onBlur}
          // A pasted image is the same arrival as a dropped one, and on a phone it is the only
          // one: there is no drag there. Text pastes fall through untouched, because a clipboard
          // carrying files is a different clipboard from one carrying words.
          {...(editor.onFiles === undefined ? {} : {
            onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              editor.onFiles?.(files);
            },
          })}
          onKeyDown={(event) => {
            // Tab takes the offer rather than leaving the field, but only while there IS one:
            // with no suggestion to accept it stays the key that moves focus.
            if (editor.onAcceptHint && event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              editor.onAcceptHint();
              return;
            }
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
          className="max-h-48 min-h-12 w-full resize-none bg-transparent px-4 py-3 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none"
        />
        </div>}
        {/* Offered only where there is a pane: a session without one has nothing to show. The one
            control that survives the swap, because it is the way back from either side. A draft
            typed in the field is still in this component's state while the terminal has the band,
            so switching away and back does not cost it. */}
        {terminalComposer ? (
          <button
            type="button"
            onClick={terminalComposer.toggle}
            aria-pressed={terminalComposer.shown}
            aria-label={terminalComposer.shown ? "Hide the terminal" : "Show the terminal"}
            title={terminalComposer.shown
              ? "Hide this session's terminal and type in the composer instead."
              : "Type in this session's terminal instead, resuming it in tmux if nothing is running it."}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
              terminalComposer.shown
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {"\u2b1a"}
          </button>
        ) : null}
        {/* Every one of these acts on the draft, so they go where the draft goes. */}
        {terminalInput ? null : actions.map((action) => (
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
