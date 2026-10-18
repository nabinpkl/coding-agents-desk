"use client";

// Which mechanism answers an open AskUserQuestion, and the one model the band draws it from.
//
// The content is never in question here. It is the tool call in the transcript, which the panel
// already holds, so a question is DRAWN for any Claude session that has one -- with no pane, no
// window, and no reading of either. Asking a pane first is what made a question unanswerable on a
// session whose own dialog had taken the composer away, and it was asking about something the
// transcript had already said.
//
// What is in question is who ACTS, and the two are genuinely different mechanisms rather than one
// behind a flag:
//
//   The pane's dialog takes keystrokes that cannot be taken back -- one digit on a single-select
//   question selects, marks and submits -- so every answer is drafted in the panel and committed
//   once, and every question of the call is answered, which is what the dialog needs to finish.
//
//   The Desktop panel is a live surface somebody may be watching, so it is mirrored click by
//   click. It shows one question at a time and nothing here has measured what it does with a call
//   carrying several, so it answers the first and the band says how many it cannot reach.
//
// The window half owns a question only where the host can AFFIRM its panel, which is a session
// showing in Claude Desktop rather than running in a pane. Everything else is the reader's own
// draft, committed against the pane when there is one.
//
// With no tool call at all, the pane's own drawing of the dialog stands in for it
// (`questionFromPane`), because a question nothing else reported is still a question.

import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { WindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import type { ClaudeSdkSessionState, TmuxQuestionRefusal, TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import type { SdkSessionHandle } from "@/features/cli-input/useSdkSession";
import type { AskUserQuestionItem, OpenAskUserQuestion } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/question/questionAnswers";
import { useTmuxQuestion, type TmuxQuestionSender } from "@/features/session-view/composer/question/useTmuxQuestion";
import { useWindowQuestion } from "@/features/session-view/composer/question/useWindowQuestion";
import { usePaneQuestion } from "@/features/session-view/composer/question/questionFromPane";

/**
 * What the band needs to draw an open question and hand its answers somewhere.
 *
 * One shape for two mechanisms, so the band never learns which of them it is attached to -- and
 * neither does the surface.
 */
export interface QuestionMirrorModel {
  /**
   * The tool call this question belongs to.
   *
   * Here so the band can key the mirror on it: the surface pages between questions and holds which
   * one is on screen, and a new call has to start at its own first question rather than wherever
   * the last one was left.
   */
  callId: string;
  questions: readonly AskUserQuestionItem[];
  drafts: readonly QuestionDraft[];
  /**
   * The option the session's own terminal has its cursor on, or null when nothing is watching it.
   *
   * A place to draw a ring, not an answer. Only the tmux half ever has one: the Desktop panel
   * reports its own selection and is mirrored click by click, so it has no separate cursor to
   * disagree with.
   */
  paneCursor: { at: number; option: number } | null;
  /**
   * Which question the terminal is showing, so the surface can page to the same one.
   *
   * Without this the mirror only worked while both happened to be on the same question, and there
   * was nothing to keep them there: the reader's panel stayed on question one while the terminal
   * moved to question two, and every reading after that was about a question nothing was drawing.
   */
  paneAt: number | null;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  notice: string | null;
  canSubmit: boolean;
  onChoose: (question: number, option: number) => void;
  /**
   * Moves the terminal's cursor to an option without answering anything.
   *
   * Separate from `onChoose` because a click that does not change the draft still has to reach the
   * terminal: re-picking the option the panel already shows is how a reader pulls the two back
   * together when they have drifted, and a checked radio fires no change event to carry it.
   */
  onPoint: (question: number, option: number) => void;
  onWriteOther: (question: number, text: string) => void;
  onSubmit: () => void;
  onSkip?: () => void;
  onDismiss?: () => void;
}

/**
 * The question an SDK session's runner is holding, in the shape the band draws.
 *
 * The only source for those sessions, and a better one than the transcript: it is complete from the
 * moment the question is asked, and it is gone the moment the call is answered, from anywhere.
 */
export function runnerQuestion(state: ClaudeSdkSessionState): OpenAskUserQuestion | null {
  const asked = state.pending.find((request) => request.kind === "question");
  if (!asked || asked.kind !== "question") return null;
  return {
    callId: asked.toolUseId,
    questions: asked.questions.map((question) => ({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    })),
  };
}

/** A refusal from an SDK session's runner, which has no terminal or screen to describe. */
export function sdkQuestionReasonText(reason: TmuxQuestionRefusal): string {
  switch (reason) {
    case "no-pane":
    case "tmux-unavailable":
      return "this session is not running, so nothing was sent";
    case "no-dialog":
      return "this question is no longer waiting, so nothing was sent";
    case "wrong-dialog":
      return "a different question is waiting now, so nothing was sent";
    case "wrong-option":
      return "the options waiting do not match the ones here, so nothing was sent";
    case "pane-stalled":
    case "still-open":
      return "the session did not confirm the answer; it may have landed";
  }
}

export function useQuestionMirror({
  feed,
  host,
  session,
  sessionId,
  isClaude,
  question,
  paneQuestion,
  engage,
  sdk = null,
}: {
  feed: TmuxQuestionSender;
  host: WindowComposerClient;
  session: SessionAddress;
  sessionId: string;
  isClaude: boolean;
  question: OpenAskUserQuestion | null;
  /**
   * What the session's own terminal shows for this question, once anything is watching it.
   *
   * The content too when `question` is null. Otherwise only the draft half uses it: the Desktop
   * panel reports its own live state and is mirrored click by click, so a second opinion read off
   * a screen would be one more thing to disagree with it.
   */
  paneQuestion: TmuxQuestionState | null;
  /**
   * Told that the reader has touched the question, which is one of the two things that attach the
   * session's pane. Called before the draft moves, so by the time there is an answer to commit the
   * panel already knows whether there is a pane to commit it to.
   */
  engage: () => void;
  /**
   * The session's runner, when it runs through the Agent SDK (ADR-0143). Then the runner's pending
   * question is the whole story: drawn from it, answered through it, and never through a pane or a
   * window, which an SDK session does not have.
   */
  sdk?: SdkSessionHandle | null;
}): QuestionMirrorModel | null {
  const fromPane = usePaneQuestion(sdk ? null : paneQuestion);
  const shown = sdk ? runnerQuestion(sdk.state) : (question ?? fromPane);
  const tmuxQuestion = useTmuxQuestion(
    sdk ? sdk.questions : feed,
    session,
    isClaude ? shown : null,
    sdk ? null : paneQuestion,
    sdk ? sdkQuestionReasonText : undefined,
  );
  const windowQuestion = useWindowQuestion(host, sessionId, isClaude && !sdk && shown != null, shown);
  if (!isClaude || shown == null) return null;
  if (sdk || !windowQuestion.visible) {
    // Read off the screen with questions it could not see: drawn, never answered, because the
    // dialog takes every question's answer at once and the others cannot be named.
    const unseen = shown.pane?.unseen ?? 0;
    return {
      callId: shown.callId,
      questions: tmuxQuestion.questions,
      drafts: tmuxQuestion.drafts,
      paneCursor: tmuxQuestion.paneCursor,
      paneAt: tmuxQuestion.paneAt,
      pending: tmuxQuestion.pending,
      disabled: unseen > 0,
      error: tmuxQuestion.error,
      notice:
        unseen > 0
          ? `The terminal is asking ${unseen + 1} questions and shows one at a time, so answer them there`
          : null,
      canSubmit: unseen === 0 && tmuxQuestion.canSubmit,
      onChoose: (at, option) => {
        engage();
        tmuxQuestion.choose(at, option);
      },
      onPoint: (at, option) => {
        engage();
        tmuxQuestion.point(at, option);
      },
      onWriteOther: (at, text) => {
        engage();
        tmuxQuestion.write(at, text);
      },
      onSubmit: () => void tmuxQuestion.submit(),
    };
  }
  if (!windowQuestion.question) return null;
  return {
    callId: shown.callId,
    questions: [windowQuestion.question],
    drafts: [{ chosen: windowQuestion.selected, other: windowQuestion.otherText }],
    // This half has no terminal to follow: what it mirrors is a Desktop panel, which reports its
    // own selection rather than a cursor moving separately from one.
    paneCursor: null,
    paneAt: null,
    pending: windowQuestion.pending,
    disabled: !windowQuestion.enabled,
    error: windowQuestion.error,
    notice:
      windowQuestion.unreachable > 0
        ? `${windowQuestion.unreachable} more question${
            windowQuestion.unreachable > 1 ? "s" : ""
          } in this call can only be answered in the app`
        : null,
    canSubmit: windowQuestion.canSubmit,
    // This half mirrors ONE question, so the index is always zero and is dropped here rather than
    // threaded through a hook that has nowhere to put it.
    onChoose: (_question, option) => windowQuestion.selectOption(option),
    // Nothing to point at: this half drives a Desktop panel, which has no cursor of its own.
    onPoint: () => {},
    onWriteOther: (_question, text) => windowQuestion.changeOther(text),
    onSubmit: windowQuestion.submit,
    onSkip: windowQuestion.skip,
    onDismiss: windowQuestion.dismiss,
  };
}
