"use client";

// The band under the transcript: a field, a terminal, or a mirror of a window's own
// composer, whichever this session's harness makes possible.

import { useCallback, useId, useMemo, useRef, useState } from "react";
import type {
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import {
  type WindowComposerClient,
} from "@/features/window-composer/WindowComposerClient";
import type {
  AgentSessionControlState,
} from "@/features/activity-feed/data-source/AgentDataSource";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import type { CliSessionHandle } from "@/features/cli-input/useCliSession";
import {
  useTmuxComposer,
} from "@/features/cli-input/useTmuxComposer";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";
import { type ComposerPaneContext, composerTerminalPane } from "@/features/session-view/composer/terminalArrangement";
import type { PanelCommandSurfaces } from "@/features/session-view/usePanelCommands";
import { useQuestionMirror } from "@/features/session-view/composer/question/useQuestionMirror";
import type { AgentTerminalComposer } from "@/features/session-view/sessionTerminalTypes";
import { useAutoGrowingTextArea } from "@/features/session-view/composer/useAutoGrowingTextArea";
import { useComposerFileDrop } from "@/features/session-view/composer/hold/useComposerFileDrop";
import { useOpencodeCommands } from "@/features/session-view/composer/useOpencodeCommands";
import { useComposerDraft, useSendAttachments, type SendAttachment } from "@/features/session-view/composer/hold/useComposerHold";
import { useWindowComposer } from "@/features/session-view/composer/useWindowComposer";
import { composerActions } from "@/features/session-view/composer/sessionComposerActions";
import {
  composerCaption,
  composerEditor,
  composerSectionLabel,
} from "@/features/session-view/composer/sessionComposerEditor";
import { composerTransport, type ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { useSdkSession } from "@/features/cli-input/useSdkSession";
import type { ClaudeSdkQueuedPrompt } from "@agentdesk/agent-feed-wire";
import { useRunModeSwitch } from "@/features/cli-input/useRunModeSwitch";
import { SessionComposerBand } from "@/features/session-view/composer/SessionComposerBand";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useLeaveEffect } from "@/hooks/useMountEffect";
import { useNotify } from "@/hooks/useNotify";

export function SessionComposer({
  feed,
  session,
  state,
  usage,
  sessionModel,
  pending,
  error,
  question,
  ownerWaiting,
  cliSession,
  windowComposerClient,
  agentTerminal,
  terminalComposer,
  terminalHeightBasis,
  onFileDrop,
  onSendMessage,
  onRunSlash,
  surfaces,
  onAbort,
  onQueuedPrompts,
}: {
  feed: SidecarDataSource;
  session: SessionSummary;
  state: AgentSessionControlState;
  usage: TokenUsage | null;
  /** The session's current model (`providerID/modelID`); beside usage, which blanks across compaction gaps. */
  sessionModel: string | null;
  pending: boolean;
  error: string | null;
  /**
   * The session's open AskUserQuestion, derived from the feed's event stream. null
   * while no question is open, which is when no mirror renders and no question
   * watch exists.
   */
  question: OpenAskUserQuestion | null;
  /** The session's process is blocked on its terminal, which may hold a dialog `question` missed. */
  ownerWaiting: boolean;
  /**
   * Whether this session is a Claude Code process in a terminal, and the way to type into it.
   * Resolved by the app, because it is a sidecar read.
   */
  cliSession: CliSessionHandle;
  /**
   * This session's window composer, bound to its source. Resolved by the app, because it is a
   * sidecar read.
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
    context: ComposerPaneContext;
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
  onSendMessage: (text: string, delivery: "next" | "steer", files?: SendAttachment[]) => Promise<void>;
  /**
   * Runs one parsed slash command, wherever it belongs: the sidecar for most, the panel for
   * `/model`, `/new`, `/fork`, `/export` and `/btw`. The session view owns that routing.
   */
  onRunSlash: (name: string, args: string) => Promise<void>;
  /** What a slash command left open over this composer; see `usePanelCommands`. */
  surfaces: PanelCommandSurfaces;
  onAbort: () => Promise<void>;
  /**
   * The prompts an SDK session holds as queued, for the feed to draw at its end. Told rather than
   * read by the feed because this band is what follows the session's runner.
   */
  onQueuedPrompts?: (queued: readonly ClaudeSdkQueuedPrompt[]) => void;
}) {
  const { source, sessionId, capabilities } = session;
  const isClaude = source === "claude";
  const isCodex = source === "codex";
  const isOpencode = source === "opencode";
  const terminalCandidate = isClaude && cliSession.isTerminalSession;
  const running = state.runState === "running";
  const queued = state.queue.followUp + state.queue.steer;

  // The session's address for the hooks below, stable because they key their streams and drafts on
  // it, and a fresh object every render would restart both on every status the Feed reads.
  const tmuxComposerSession = useMemo(() => ({ source, sessionId }), [source, sessionId]);
  // An SDK session's runner (ADR-0143), followed for every Claude session rather than only those the
  // registry already names: a new one's card opens before its `claude` has registered, and the
  // registry is read once per selection. The stream says the moment a runner answers -- the sidecar
  // learns of its socket from a directory watch -- and costs an idle stream where none ever does.
  const sdkSession = useSdkSession(feed, tmuxComposerSession, isClaude);
  const sdkCandidate = isClaude && (cliSession.isSdkSession || sdkSession.state.connected);
  const queuedPrompts = sdkSession.state.queued;
  useNotify(queuedPrompts, (prompts) => onQueuedPrompts?.(prompts));
  const runModeSwitch = useRunModeSwitch(feed, tmuxComposerSession, cliSession.refresh);
  const windowCandidate = (isClaude || isCodex) && !terminalCandidate && !sdkCandidate;

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
  // Asked for every Claude session rather than only for `terminalCandidate` ones, and that is not
  // caution -- it is the difference between this working and never appearing. `entrypoint` says
  // how a session was LAUNCHED, and every live tmux session on this machine reports
  // `claude-desktop` because they were forked from Remote Control: measured, all ten of them.
  // Whether there is a box to mirror is a different question, and the sidecar answers it by
  // looking for the pane. Codex is left out because the box this reads is Claude's TUI's, which
  // is also why the route refuses any other source.
  //
  // ...but not until the reader means to use it. Opening this stream puts a `tmux pipe-pane` on
  // the session's pane, and a reader who opened a thread to READ it has asked for nothing: the
  // transcript and everything else on screen come from files the sidecar already watches. So
  // looking costs the pane nothing, and intent is what attaches -- reaching for the field. The
  // draft carry-over below is what makes the band changing hands at that moment invisible to
  // whoever is mid-sentence.
  //
  // An OPEN QUESTION is its own intent, and that is a change: touching the question used to be
  // what attached the pane, and it made the mirror useless for the thing it exists to do. While a
  // dialog stands in that pane it is a live surface somebody may be walking with the arrow keys,
  // and what the panel has to show is where they have got to -- which it cannot learn without
  // watching. Waiting for a touch meant the reader had to answer before they could see what was
  // already answered, so the first thing the mirror told them was nothing.
  //
  // Bounded, which is what makes it affordable: a question is open for part of a turn rather than
  // for the life of a session, and only the session this band is rendered for has one watched.
  const [engaged, setEngaged] = useStateFor(`${source}/${sessionId}`, () => false);
  const engage = useCallback(() => setEngaged(true), [setEngaged]);
  // Held here rather than in the pane: an opencode session has no pane, so picked images wait
  // for the send instead. Keyed by the session, so a strip never rides into another thread and
  // this thread's own staged images are still there when the reader comes back to it.
  const sendAttachments = useSendAttachments(`${source}/${sessionId}`);
  const tmuxComposer = useTmuxComposer(
    feed,
    tmuxComposerSession,
    // A process blocked on its terminal attaches it too: a dialog the feed never reported is
    // still standing there, and only the pane can say so (`questionFromPane`). Never an SDK
    // session's pane, which holds the runner's log rather than a prompt box.
    isClaude && !sdkCandidate && (engaged || question !== null || ownerWaiting),
  );

  // Delivery priority is one explicit state; `composerTransport` says why it is in this order.
  const transport = composerTransport({
    sdkCandidate,
    mirrored: tmuxComposer.mirrored,
    terminalCandidate,
    windowCandidate,
    windowRefused: windowComposer.statusKnown && !windowComposer.enabled,
    agentTerminal,
  });
  const windowBand = transport.kind === "window";
  const tmuxBand = transport.kind === "tmux-composer";
  const cliSessionBand = transport.kind === "cli-session";
  const agentTerminalBand = transport.kind === "agent-terminal";
  const sdkBand = transport.kind === "sdk-session";

  // Hands the session the function that takes a dropped image, so the card is the target.
  // Refused only where the panel KNOWS there is nowhere to put it: a Claude session whose pane
  // has been looked for and not found. Not having attached means nobody has asked yet, and
  // saying "no composer" then would be a guess dressed as a fact.
  const fileAccept = useComposerFileDrop({
    // An SDK session's pane is the runner's log, so its images wait for the send instead.
    isClaude: isClaude && !sdkCandidate,
    noPane: tmuxComposer.reason === "no-pane",
    holdsForSend: isOpencode || sdkCandidate,
    dropToPane: tmuxComposer.drop,
    holdForSend: sendAttachments.attach,
    engage,
    onFileDrop,
  });

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
    // Live for as long as a question is open, because the question is what attaches the pane. The
    // mirror draws from the tool call either way; this is only what the terminal already holds.
    paneQuestion: tmuxComposer.paneQuestion,
    engage,
    sdk: sdkCandidate ? sdkSession : null,
  });

  // Every non-window transport composes against local state. If native resolution refuses after
  // somebody has already typed, hand that exact draft to the selected local transport before the
  // native watcher releases ownership.
  //
  // Remembered per session, because a reload otherwise threw away a half-written sentence the
  // same way it threw away staged images. The setter writes through to storage itself, so the
  // send path's existing `setLocalDraft("")` empties the remembered copy too: one place changes
  // the draft, and the field and the store cannot drift apart.
  const [localDraft, setLocalDraft] = useComposerDraft(`${source}/${sessionId}`);
  /**
   * The file picker behind the paperclip.
   *
   * A hidden input rather than a component, because the browser's own picker is the only way to
   * reach a phone's photo library -- and on a phone it is the ONLY way in: there is no drag, and a
   * clipboard that holds an image is a rarer thing there than a camera roll that does.
   */
  const filePickerId = useId();
  const previousTransport = useRef(transport.kind);
  // When the field changes owner, what it held moves to the new one. Run as the old transport is
  // left, with the values of the render that replaced it.
  useLeaveEffect(transport.kind, () => {
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
  });
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

  // The pane that stands above the field, or null when this session's is hidden.
  const terminalPane = composerTerminalPane(terminalComposer, terminalHeightBasis);

  const [deliveryPending, setDeliveryPending] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const piUnavailable = !isClaude && !isCodex && !capabilities.canSend;
  const unavailable = sdkBand
    ? !sdkSession.state.connected
    : windowBand || tmuxBand
    ? false
    : cliSessionBand
      // Unavailable once the pane has been looked for and not found; until then the field is what
      // attaches it.
      ? tmuxComposer.reason === "no-pane"
      : agentTerminalBand
        ? false
        : piUnavailable;

  const model: ComposerModel = {
    acceptFiles: fileAccept,
    agentTerminalBand,
    capabilities,
    cliSessionBand,
    deliveryError,
    deliveryPending,
    editorValue,
    engage,
    error,
    filePickerId,
    isClaude,
    isCodex,
    localDraft,
    onAbort,
    onRunSlash,
    onSendMessage,
    opencodeCommands: useOpencodeCommands(feed, isOpencode ? tmuxComposerSession : null),
    pending,
    queued,
    running,
    sendAttachments,
    sdkBand,
    sdkSession,
    runMode: sdkBand ? "sdk" : isClaude && cliSession.isTerminalSession ? "terminal" : null,
    runModeSwitch,
    liveProcesses: cliSession.liveProcesses,
    session,
    sessionModel: sessionModel ?? usage?.model ?? null,
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
      filePickerId={filePickerId}
      onPickFiles={fileAccept}
      isClaude={isClaude}
      isCodex={isCodex}
      model={model}
      surfaces={surfaces}
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
