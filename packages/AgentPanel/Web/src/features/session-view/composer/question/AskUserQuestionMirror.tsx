"use client";

// Claude's AskUserQuestion, mirrored into the panel: one question of the call at a time, its
// options, and the free-text row it carries, in the frame every question is drawn in
// (`QuestionFrame`).
//
// Content comes from the transcript's own tool_use, never from reading a screen or an
// accessibility tree, so what a reader sees here is exactly what the model asked -- untruncated,
// unwrapped, with the previews the terminal can only show one at a time.
//
// The surface only. Which mechanism actually answers is the caller's: `useTmuxQuestion` drafts
// every answer and commits once against the pane, `useWindowQuestion` mirrors a Claude Desktop
// panel click by click. They differ because the two dialogs differ, and the rendering does not
// need to know which one it is attached to.

import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/question/questionAnswers";
import { isAnswered } from "@/features/session-view/composer/question/questionAnswers";
import { QuestionFrame } from "@/features/session-view/composer/question/QuestionFrame";
import { QuestionSection } from "@/features/session-view/composer/question/QuestionSection";

const EMPTY: QuestionDraft = { chosen: [], other: "" };

export function AskUserQuestionMirror({
  questions,
  drafts,
  pending,
  disabled,
  error,
  notice,
  canSubmit,
  paneCursor,
  paneAt,
  onChoose,
  onPoint,
  onWriteOther,
  onSubmit,
  onSkip,
  onDismiss,
}: {
  questions: readonly AskUserQuestionItem[];
  /** One per question, in the same order. The caller owns them; this only renders them. */
  drafts: readonly QuestionDraft[];
  pending: boolean;
  disabled: boolean;
  error: string | null;
  /** A standing fact about this surface, as opposed to something that went wrong. */
  notice?: string | null;
  canSubmit: boolean;
  /**
   * Where the session's own terminal has its cursor, or null when nothing is watching that pane.
   *
   * Optional because only one of the two mechanisms behind this surface has a terminal at all,
   * and because a pane is not attached until the reader touches something -- so null is the
   * ordinary state, not a failure.
   */
  paneCursor?: { at: number; option: number } | null;
  /** Which question the session's own terminal is showing, or null when nothing is watching it. */
  paneAt?: number | null;
  onChoose: (question: number, option: number) => void;
  /** Moves the terminal's cursor to an option, answering nothing. */
  onPoint?: (question: number, option: number) => void;
  onWriteOther: (question: number, text: string) => void;
  onSubmit: () => void;
  onSkip?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <QuestionFrame
      label="Claude question"
      name="Claude's question"
      questions={questions}
      answered={questions.map((_, index) => isAnswered(drafts[index] ?? EMPTY))}
      pending={pending}
      disabled={disabled}
      error={error}
      notice={notice}
      canSubmit={canSubmit}
      paneAt={paneAt}
      onSubmit={onSubmit}
      onSkip={onSkip}
      onDismiss={onDismiss}
      renderQuestion={(at, { showHeader, inert }) => (
        <QuestionSection
          question={questions[at]!}
          draft={drafts[at] ?? EMPTY}
          // The tab strip is already showing every header, so repeating it here would say the
          // same word twice. With one question there is no strip, and it would be lost.
          showHeader={showHeader}
          // Only when the terminal is on the same question this surface is showing. The pager
          // here and the tab in the pane move independently, and a ring drawn from the wrong
          // question would land on whatever option happened to share its index.
          cursor={paneCursor?.at === at ? paneCursor.option : null}
          inert={inert}
          onChoose={(option) => onChoose(at, option)}
          onPoint={(option) => onPoint?.(at, option)}
          onWriteOther={(text) => onWriteOther(at, text)}
        />
      )}
    />
  );
}
