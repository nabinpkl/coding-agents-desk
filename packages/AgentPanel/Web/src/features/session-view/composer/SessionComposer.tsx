"use client";

// The band under the transcript: a field, a terminal, or a mirror of a window's own
// composer, whichever this session's harness makes possible.

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
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentUiRequest,
  SessionSummary,
  SessionTmuxTerminalContext,
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
import { TokenMeter } from "@/features/activity-feed/TokenMeter";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import { BackgroundTasksPanel } from "@/features/background-tasks/BackgroundTasksPanel";
import { RunningTasksChip } from "@/features/background-tasks/RunningTasksChip";
import { useBackgroundTasks } from "@/features/background-tasks/useBackgroundTasks";
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
import { terminalArrangement } from "@/features/session-view/composer/terminalArrangement";
import { useQuestionMirror } from "@/features/session-view/composer/question/useQuestionMirror";
import { ExtensionUISurface } from "@/features/session-view/SessionExtensionUI";
import {
  composerReasonText,
  TerminalControl,
  TerminalNotice,
} from "@/features/session-view/SessionTerminalControls";
import type { AgentTerminalComposer, TerminalState } from "@/features/session-view/sessionTerminalTypes";
import { useAutoGrowingTextArea } from "@/features/session-view/composer/useAutoGrowingTextArea";
import { useWindowComposer } from "@/features/session-view/composer/useWindowComposer";
import { harnessName } from "@/features/session-view/SessionView";
import { composerActions, submitComposer, submitOwnedTransport } from "@/features/session-view/composer/sessionComposerActions";
import {
  composerCaption,
  composerEditor,
  composerSectionLabel,
} from "@/features/session-view/composer/sessionComposerEditor";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { SessionComposerBand } from "@/features/session-view/composer/SessionComposerBand";

/** One action in the composer, rendered in array order in the place its `placement` names. */
export type ComposerAction = {
  key: string;
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  disabled: boolean;
  className: string;
  onClick: () => void;
  /**
   * Where it is drawn. Omitted is the row beside the field; `field` is inside it at its trailing
   * edge (the send); `footer` is the small line under it, beside the context meter.
   */
  placement?: "field" | "footer";
};

export function SessionComposer({
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
  onFileDrop,
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
    /** The height this session's pane was left at, and where a new one goes. */
    height: number | null;
    onResized: (height: number) => void;
  } | null;
  /**
   * What this band's terminal takes its height as a share of, and whether it renders at all: the
   * pane waits for it rather than mounting against the viewport for a render and re-fitting itself
   * once the real reference arrives.
   */
  terminalHeightBasis: HTMLElement | null;
  /**
   * Publishes what can take a dropped image, so the whole session is the target rather than this
   * band. Called with null whenever nothing here holds one, including on unmount.
   */
  onFileDrop: (drop: { accept: (files: readonly File[]) => void } | null) => void;
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
  // ...but not until the reader means to use it. Opening this stream puts a `tmux pipe-pane` on
  // the session's pane, and a reader who opened a thread to READ it has asked for nothing: the
  // transcript, the question and everything else on screen come from files the sidecar already
  // watches. So looking costs the pane nothing, and intent is what attaches -- reaching for the
  // field, or touching the question the session is waiting on. The draft carry-over below is what
  // makes the band changing hands at that moment invisible to whoever is mid-sentence.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => setEngaged(false), [source, sessionId]);
  const engage = useCallback(() => setEngaged(true), []);
  const tmuxComposer = useTmuxComposer(feed, tmuxComposerSession, isClaude && engaged);

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

  /**
   * Hands the session the function that takes a dropped image, so the card is the target.
   *
   * `tmuxComposer.drop` rather than `editor.onFiles`, which is the same function behind a fresh
   * arrow every render and would re-register on each keystroke. The tmux band is the only one with
   * a box to put an image in: Claude's own composer is what turns a pasted path into an image, and
   * nothing on the window, inbox or pty bands holds one.
   *
   * It stays registered while the terminal is showing instead of the field. The pane IS the
   * composer, so an image dropped then lands in the box the reader is already looking at.
   */
  //
  // Registered for every Claude session rather than only for an attached band, because a dropped
  // image is intent as much as a keystroke is and there is nothing to drop onto if the target
  // waits for the pane. The drop itself is a POST that resolves the pane for itself; engaging
  // beside it is what brings the box into the field, so the `[Image #1]` the pane writes appears
  // where the reader is typing rather than in a mirror nobody opened.
  const dropFiles = tmuxComposer.drop;
  const acceptFiles = useCallback((files: readonly File[]) => {
    engage();
    void dropFiles(files);
  }, [dropFiles, engage]);
  // Refused only where the panel KNOWS there is nowhere to put it, which is a session whose pane
  // has already been looked for and not found. It used to be refused wherever the band had not
  // attached, and that reading is no longer available: not having attached now means nobody has
  // asked yet. Saying "no composer" then would be a guess dressed as a fact, and the wrong one
  // for every session that has a pane nobody has touched.
  const noPane = tmuxComposer.reason === "no-pane";
  useEffect(() => {
    // Claude only: its own composer is what turns a pasted path into an image, and no other band
    // holds a box to put one in.
    onFileDrop(isClaude && !noPane ? { accept: acceptFiles } : null);
    return () => onFileDrop(null);
  }, [isClaude, noPane, onFileDrop, acceptFiles]);

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

  // Who answers an open question, and the one model the band draws it from. The content never
  // depends on either mechanism: it is the tool call the transcript already carries.
  const questionMirror = useQuestionMirror({
    feed,
    host: windowComposerClient,
    session: tmuxComposerSession,
    sessionId,
    isClaude,
    question,
    engage,
  });

  // Every non-window transport composes against local state. If native resolution refuses after
  // somebody has already typed, hand that exact draft to the selected local transport before the
  // native watcher releases ownership.
  const [localDraft, setLocalDraft] = useState("");
  /**
   * The file picker behind the paperclip.
   *
   * A hidden input rather than a component, because the browser's own picker is the only way to
   * reach a phone's photo library -- and on a phone it is the ONLY way in: there is no drag, and a
   * clipboard that holds an image is a rarer thing there than a camera roll that does.
   */
  const filePicker = useRef<HTMLInputElement>(null);
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
  /**
   * Whether the key rail is standing under the field.
   *
   * Focus rather than "there is a draft", because the rail is how a phone reaches Escape -- and
   * the moment it is most wanted is a box the reader wants to clear, which is a box they have just
   * typed into and may have emptied again.
   *
   * Read once per band rather than at import, the same way the terminal's rail does it: a browser
   * does not grow a software keyboard part way through a session, and a test has to be able to say
   * which kind of browser it is.
   */
  const [composerFocused, setComposerFocused] = useState(false);
  // Reaching for the field is the first of the two intents that attach the pane; touching the
  // open question is the other, below. Focus rather than the first keystroke, so the box is
  // already showing what the pane holds by the time a character is typed into it.
  const noteComposerFocus = useCallback((focused: boolean) => {
    setComposerFocused(focused);
    if (focused) engage();
  }, [engage]);
  const [softwareKeyboard] = useState(drawsOwnKeyboard);

  // The pane that stands above the field, or null when this session's is hidden. The field is not
  // part of this decision: it is the surface every session has, and the control is about what is
  // ABOVE it rather than about which of two surfaces gets the band.
  const paneLayout = terminalArrangement(
    Boolean(terminalComposer?.shown),
    Boolean(terminalHeightBasis),
  );
  const terminalPane = terminalComposer && paneLayout
    ? {
      context: terminalComposer.context,
      layout: paneLayout,
      height: terminalComposer.height,
      onResized: terminalComposer.onResized,
    }
    : null;

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

  const model: ComposerModel = {
    acceptFiles: isClaude && !noPane ? acceptFiles : null,
    agentTerminalBand,
    capabilities,
    cliInput,
    deliveryError,
    deliveryPending,
    editorValue,
    error,
    filePicker,
    inboxBand,
    isClaude,
    isCodex,
    localDraft,
    onAbort,
    onSendMessage,
    pending,
    queued,
    running,
    session,
    setDeliveryError,
    setDeliveryPending,
    setLocalDraft,
    state,
    tmuxBand,
    tmuxComposer,
    transport,
    unavailable,
    windowBand,
    windowComposer,
  };
  const editor = composerEditor(model);
  const actions = composerActions(model);
  const { caption, captionIsError } = composerCaption(model);
  const sectionLabel = composerSectionLabel(model);

  return (
    <SessionComposerBand
      actions={actions}
      autoGrow={autoGrow}
      caption={caption}
      captionIsError={captionIsError}
      composerFocused={composerFocused}
      editor={editor}
      feed={feed}
      filePicker={filePicker}
      onPickFiles={isClaude && !noPane ? acceptFiles : null}
      isClaude={isClaude}
      isCodex={isCodex}
      model={model}
      noteTerminalState={noteTerminalState}
      questionMirror={questionMirror}
      sectionLabel={sectionLabel}
      session={session}
      setComposerFocused={noteComposerFocus}
      softwareKeyboard={softwareKeyboard}
      terminalComposer={terminalComposer}
      terminalHeightBasis={terminalHeightBasis}
      terminalPane={terminalPane}
      usage={usage}
    />
  );
}
