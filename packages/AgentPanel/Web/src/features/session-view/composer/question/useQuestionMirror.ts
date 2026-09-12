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

import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { WindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import type { AskUserQuestionItem, OpenAskUserQuestion } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/question/questionAnswers";
import {
  useTmuxQuestion,
  type TmuxQuestionSender,
} from "@/features/session-view/composer/question/useTmuxQuestion";
import { useWindowQuestion } from "@/features/session-view/composer/question/useWindowQuestion";

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
  pending: boolean;
  disabled: boolean;
  error: string | null;
  notice: string | null;
  canSubmit: boolean;
  onChoose: (question: number, option: number) => void;
  onWriteOther: (question: number, text: string) => void;
  onSubmit: () => void;
  onSkip?: () => void;
  onDismiss?: () => void;
}

export function useQuestionMirror({
  feed,
  host,
  session,
  sessionId,
  isClaude,
  question,
  engage,
}: {
  feed: TmuxQuestionSender;
  host: WindowComposerClient;
  session: SessionAddress;
  sessionId: string;
  isClaude: boolean;
  question: OpenAskUserQuestion | null;
  /**
   * Told that the reader has touched the question, which is one of the two things that attach the
   * session's pane. Called before the draft moves, so by the time there is an answer to commit the
   * panel already knows whether there is a pane to commit it to.
   */
  engage: () => void;
}): QuestionMirrorModel | null {
  const tmuxQuestion = useTmuxQuestion(feed, session, isClaude ? question : null);
  const windowQuestion = useWindowQuestion(host, sessionId, isClaude && question != null, question);
  if (!isClaude || question == null) return null;
  if (!windowQuestion.visible) {
    return {
      callId: question.callId,
      questions: tmuxQuestion.questions,
      drafts: tmuxQuestion.drafts,
      pending: tmuxQuestion.pending,
      disabled: false,
      error: tmuxQuestion.error,
      notice: null,
      canSubmit: tmuxQuestion.canSubmit,
      onChoose: (at, option) => {
        engage();
        tmuxQuestion.choose(at, option);
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
    callId: question.callId,
    questions: [windowQuestion.question],
    drafts: [{ chosen: windowQuestion.selected, other: windowQuestion.otherText }],
    pending: windowQuestion.pending,
    disabled: !windowQuestion.enabled,
    error: windowQuestion.error,
    notice: windowQuestion.unreachable > 0
      ? `${windowQuestion.unreachable} more question${
        windowQuestion.unreachable > 1 ? "s" : ""
      } in this call can only be answered in the app`
      : null,
    canSubmit: windowQuestion.canSubmit,
    // This half mirrors ONE question, so the index is always zero and is dropped here rather than
    // threaded through a hook that has nowhere to put it.
    onChoose: (_question, option) => windowQuestion.selectOption(option),
    onWriteOther: (_question, text) => windowQuestion.changeOther(text),
    onSubmit: windowQuestion.submit,
    onSkip: windowQuestion.skip,
    onDismiss: windowQuestion.dismiss,
  };
}
