"use client";

// Claude's AskUserQuestion, mirrored into the panel: every question of the call, its options, and
// the free-text row each one carries.
//
// Content comes from the transcript's own tool_use, never from reading a screen or an
// accessibility tree, so what a reader sees here is exactly what the model asked -- untruncated,
// unwrapped, with the previews the terminal can only show one at a time.
//
// The surface only. Which mechanism actually answers is the caller's: `useTmuxQuestion` drafts
// every answer and commits once against the pane, `useWindowQuestion` mirrors a Claude Desktop
// panel click by click. They differ because the two dialogs differ, and the rendering does not
// need to know which one it is attached to.

import { LoaderCircle, X } from "lucide-react";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/questionAnswers";
import { isAnswered } from "@/features/session-view/composer/questionAnswers";

export function AskUserQuestionMirror({
  questions,
  drafts,
  pending,
  disabled,
  error,
  notice,
  canSubmit,
  onChoose,
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
  onChoose: (question: number, option: number) => void;
  onWriteOther: (question: number, text: string) => void;
  onSubmit: () => void;
  onSkip?: () => void;
  onDismiss?: () => void;
}) {
  const inert = pending || disabled;
  const many = questions.length > 1;
  return (
    <section
      aria-label="Claude question"
      className="mb-3 rounded-xl border border-border bg-background p-3"
    >
      {onDismiss ? (
        <div className="mb-1 flex justify-end">
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
      ) : null}
      {questions.map((question, at) => (
        <QuestionSection
          key={at}
          question={question}
          draft={drafts[at] ?? { chosen: [], other: "" }}
          // Numbered only when there is more than one, because "1 of 1" is a label for nothing.
          position={many ? `${at + 1} of ${questions.length}` : null}
          inert={inert}
          onChoose={(option) => onChoose(at, option)}
          onWriteOther={(text) => onWriteOther(at, text)}
        />
      ))}
      <div className="mt-2 flex items-center justify-end gap-2">
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            disabled={inert}
            className="h-8 rounded-lg px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Skip
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSubmit}
          disabled={inert || !canSubmit}
          aria-label="Submit answer"
          className="flex h-8 items-center justify-center gap-1 rounded-lg bg-primary px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {many ? "Submit answers" : "Submit"} ⏎
        </button>
      </div>
      {/* The unanswered count rather than a disabled button with no explanation: with four
          questions stacked, which one is still empty is not obvious from the button. */}
      {!canSubmit && questions.length > 0 ? (
        <p className="px-1 pt-1 text-right text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {unansweredText(questions, drafts)}
        </p>
      ) : null}
      {notice ? (
        <p className="px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          aria-live="polite"
          className="px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

function unansweredText(
  questions: readonly AskUserQuestionItem[],
  drafts: readonly QuestionDraft[],
): string {
  const missing = questions.filter((_, at) => !isAnswered(drafts[at] ?? { chosen: [], other: "" }));
  if (missing.length === questions.length && questions.length === 1) return "Choose an option, or type your own";
  return `${missing.length} of ${questions.length} still to answer`;
}

/** One question: what it asks, what it offers, and the row for an answer it did not offer. */
function QuestionSection({
  question,
  draft,
  position,
  inert,
  onChoose,
  onWriteOther,
}: {
  question: AskUserQuestionItem;
  draft: QuestionDraft;
  position: string | null;
  inert: boolean;
  onChoose: (option: number) => void;
  onWriteOther: (text: string) => void;
}) {
  const name = `ask-user-question-${question.question}`;
  return (
    <div className="border-border not-first:mt-3 not-first:border-t not-first:pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground">
          {question.question}
        </p>
        {position ? (
          <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {position}
          </span>
        ) : null}
      </div>
      {question.header ? (
        <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {question.header}
          {question.multiSelect ? " · choose any" : ""}
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        {question.options.map((option, index) => {
          const id = `${name}-${index}`;
          return (
            <div key={index} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
              <input
                id={id}
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.multiSelect ? undefined : name}
                checked={draft.chosen.includes(index)}
                disabled={inert}
                onChange={() => onChoose(index)}
                aria-label={option.label}
                className="mt-1 size-4 accent-primary"
              />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 cursor-pointer text-(length:--agent-panel-fs-sidebar-body,15px) leading-6"
              >
                <span className="font-medium text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="block text-(length:--agent-panel-fs-sidebar-meta,13px) leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
                {/* Preformatted and scrollable: a preview is a small diagram, and reflowing it
                    would take away the thing it was drawn to show. */}
                {option.preview ? (
                  <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-muted/60 px-2 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) leading-5 text-muted-foreground">
                    {option.preview}
                  </pre>
                ) : null}
              </label>
            </div>
          );
        })}
        <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
          <input
            id={`${name}-other`}
            type={question.multiSelect ? "checkbox" : "radio"}
            name={question.multiSelect ? undefined : name}
            checked={draft.other.trim().length > 0}
            disabled={inert}
            // Checking it is what typing does; the control is here so the row reads like the
            // others rather than as a stray field under them.
            onChange={() => onWriteOther("")}
            aria-label="Something else"
            className="mt-1 size-4 accent-primary"
          />
          <input
            type="text"
            value={draft.other}
            disabled={inert}
            onChange={(event) => onWriteOther(event.target.value)}
            placeholder="Something else"
            aria-label={`Your own answer to: ${question.question}`}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-40"
          />
        </div>
      </div>
    </div>
  );
}
