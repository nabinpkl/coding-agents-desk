"use client";

// One question of an open AskUserQuestion: what it asks, what it offers, and the row for an answer
// it did not offer.
//
// Its own file rather than a section of `AskUserQuestionMirror.tsx` because that file reached the
// 500-line cap, and this is the part of it that is about one question rather than about the call:
// the pager, the tab strip and the folded bar all belong to the call, and this belongs to the
// question on screen. The split follows the same seam the props already did.

import { useRef } from "react";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import type { QuestionDraft } from "@/features/session-view/composer/question/questionAnswers";

/** One question: what it asks, what it offers, and the row for an answer it did not offer. */
export function QuestionSection({
  question,
  draft,
  showHeader,
  cursor,
  inert,
  onChoose,
  onPoint,
  onWriteOther,
}: {
  question: AskUserQuestionItem;
  draft: QuestionDraft;
  showHeader: boolean;
  /**
   * The option the session's own terminal has its cursor on, or null when it has none here.
   *
   * Drawn as a ring rather than as the checked control, because the two say different things: the
   * checkbox is this reader's answer and the ring is where the terminal's highlight is sitting.
   * They are routinely on different rows, and an answered single-select question in the pane is
   * exactly that case -- the tick on the chosen row, the cursor back on row one.
   */
  cursor: number | null;
  inert: boolean;
  onChoose: (option: number) => void;
  /** Moves the terminal's cursor to this option, answering nothing. */
  onPoint: (option: number) => void;
  onWriteOther: (text: string) => void;
}) {
  const name = `ask-user-question-${question.question}`;
  const typed = draft.other.trim().length > 0;
  const field = useRef<HTMLInputElement | null>(null);
  // Picking the free-text row is a move to it, not a value: it clears the option this question
  // was holding (single-select, where they are alternatives) and puts the cursor in the field.
  // Pressing it while it already holds words is the one case that means "not this after all".
  const pickOther = () => {
    if (typed) {
      onWriteOther("");
      return;
    }
    if (!question.multiSelect && draft.chosen[0] !== undefined) onChoose(draft.chosen[0]);
    field.current?.focus();
  };
  return (
    <div className="pt-1">
      <p className="text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground">
        {question.question}
      </p>
      {showHeader && question.header ? (
        <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {question.header}
          {question.multiSelect ? " \u00b7 choose any" : ""}
        </p>
      ) : question.multiSelect ? (
        <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          Choose any
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        {question.options.map((option, index) => {
          const id = `${name}-${index}`;
          return (
            <div
              key={index}
              // Said on hover rather than in a line under the list: a ring nobody can explain is
              // worse than no ring, and a sentence standing under every question forever to
              // explain one that appears occasionally is worse than both.
              title={cursor === index ? "The session's terminal has its cursor on this option" : undefined}
              // On the ROW, not on the input, because the input is the half that goes quiet: a
              // radio already checked fires no change event, so re-picking the option this panel
              // already shows reached nothing -- and that is precisely the gesture for pulling the
              // terminal back when it has drifted somewhere else.
              onClick={() => { if (!inert) onPoint(index); }}
              className={`flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50 ${
                cursor === index ? "bg-primary/5 ring-1 ring-primary/40" : ""
              }`}
            >
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
            type={question.multiSelect ? "checkbox" : "radio"}
            name={question.multiSelect ? undefined : name}
            checked={typed}
            disabled={inert}
            onChange={pickOther}
            aria-label="Something else"
            className="mt-1 size-4 accent-primary"
          />
          <input
            ref={field}
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
