"use client";

// The frame a session's questions are drawn in: one question of the call at a time, a tab per
// question, the pager, the fold, and the row that submits them all.
//
// One at a time, and clamped. Drawing all of a call's questions stacked was correct about the
// content and wrong about the room: the band sits above the transcript and does not scroll, so a
// tall call pushed the conversation it is about off the screen, and the only scroller that could
// reach the Submit button was the page's. Paging is what the dialog in the terminal does anyway --
// one question, a tab strip, Next -- so this is parity rather than a second idea. The answers are
// all still drafted at once and still sent in one request; only the drawing is one at a time.
//
// The call only. What one question looks like is the caller's (`renderQuestion`), because the two
// tools drawn in this frame ask differently: Claude's AskUserQuestion (`AskUserQuestionMirror`) and
// our own ask_owner (`AskOwnerCard`), which adds notes on options and questions answered in words.

import { type ReactNode, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LoaderCircle, X } from "lucide-react";

/** What the frame needs to know of one question: what to call its tab and its folded row. */
export interface FramedQuestion {
  question: string;
  header?: string;
}

export function QuestionFrame({
  label,
  name,
  questions,
  answered,
  pending,
  disabled,
  error,
  notice,
  canSubmit,
  paneAt,
  hint,
  renderQuestion,
  onSubmit,
  onSkip,
  onDismiss,
}: {
  /** What a screen reader calls the whole frame. */
  label: string;
  /** What the folded row offers to reopen, as in "Reopen Claude's question". */
  name: string;
  questions: readonly FramedQuestion[];
  /** One per question, in the same order: whether it has an answer to send. */
  answered: readonly boolean[];
  pending: boolean;
  disabled: boolean;
  error: string | null;
  /** A standing fact about this surface, as opposed to something that went wrong. */
  notice?: string | null;
  canSubmit: boolean;
  /** Which question something outside the panel is showing, to page along with; null for none. */
  paneAt?: number | null;
  /** What is left to do, for a single question with nothing answered. */
  hint?: string;
  /** The question on screen. `showHeader` is false while the tab strip already names it. */
  renderQuestion: (at: number, frame: { showHeader: boolean; inert: boolean }) => ReactNode;
  onSubmit: () => void;
  onSkip?: () => void;
  onDismiss?: () => void;
}) {
  // Which question is on screen. Transient view state, so it lives here rather than in the draft:
  // the band keys this frame by the call, so a new call starts back at the first question without
  // an effect to say so.
  const [at, setAt] = useState(() => paneAt ?? 0);
  // Folded away, and folded back out again. The band does not scroll and sits between the
  // transcript and the composer, so a question with four options and a preview on each takes the
  // conversation it is about down to a sliver -- and a reader who wants to go back and READ before
  // answering has nowhere to put it. The same key that resets the pager resets this, so a new call
  // arrives open: a question nobody has seen yet is not one anybody asked to hide.
  //
  // Not stored. It is one tap to redo, it is about a call that ends within the turn, and a stored
  // fold would have to be aged out of storage by the same reader's next thousand questions.
  const [shownWhole, setShownWhole] = useState(true);
  // Follows the terminal to whichever question it is on. Without this the mirror only worked while
  // the two happened to agree: the terminal moves to the next question as soon as one is answered,
  // and a panel left behind on the previous one drew no cursor and looked like nothing was
  // mirroring at all.
  //
  // Keyed on the pane's own index rather than run every render, so paging by hand still works --
  // it holds until the terminal actually moves, which is the point at which following it is what
  // a reader wants.
  const [followed, setFollowed] = useState(paneAt);
  if (followed !== paneAt) {
    setFollowed(paneAt);
    if (paneAt !== null && paneAt !== undefined) setAt(paneAt);
  }
  const inert = pending || disabled;
  const many = questions.length > 1;
  const shown = Math.min(at, Math.max(questions.length - 1, 0));
  const question = questions[shown];
  const missing = questions.filter((_, index) => !answered[index]).length;
  if (!question) return null;
  if (!shownWhole) {
    return (
      <FoldedQuestion
        question={question}
        name={name}
        total={questions.length}
        missing={missing}
        pending={pending}
        error={error}
        onOpen={() => setShownWhole(true)}
      />
    );
  }
  return (
    <section aria-label={label} className="mb-3 rounded-xl border border-border bg-background">
      <div className="flex items-center gap-2 px-3 pt-2">
        {many ? (
          <QuestionTabs questions={questions} answered={answered} shown={shown} onGo={setAt} />
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => setShownWhole(false)}
          aria-expanded
          aria-label="Collapse question"
          title="Fold the question away and give the room back to the transcript"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
        >
          <ChevronUp className="size-4" aria-hidden />
        </button>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            disabled={inert}
            aria-label="Dismiss question"
            title="Dismiss the question without answering"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {/* The clamp. `overscroll-contain` is the load-bearing half of it: without it a scroll that
          reaches the end of this list carries on into the transcript behind, so answering a long
          question moves the conversation the question is about. */}
      <div className="max-h-[min(45vh,340px)] overflow-y-auto overscroll-contain px-3 pb-1">
        {/* Keyed so moving between questions gives the fields a fresh start rather than ones that
            keep the previous question's selection and scroll position. */}
        <div key={shown}>{renderQuestion(shown, { showHeader: !many, inert })}</div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        {many ? (
          <>
            <Step label="Previous question" at={shown > 0} inert={inert} onClick={() => setAt(shown - 1)}>
              <ChevronLeft className="size-4" aria-hidden />
            </Step>
            <Step
              label="Next question"
              at={shown < questions.length - 1}
              inert={inert}
              onClick={() => setAt(shown + 1)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Step>
          </>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {hintText(questions.length, missing, hint)}
        </span>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            disabled={inert}
            className="h-8 shrink-0 rounded-lg px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Skip
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSubmit}
          disabled={inert || !canSubmit}
          aria-label="Submit answer"
          className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg bg-primary px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {many ? "Submit all" : "Submit"} ⏎
        </button>
      </div>
      {notice ? (
        <p className="px-4 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">{notice}</p>
      ) : null}
      {error ? (
        <p aria-live="polite" className="px-4 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The question folded down to one row, and the way back out of it.
 *
 * The whole row is the control, so reopening costs a tap anywhere along it rather than a hit on a
 * 16px chevron with a thumb. It keeps the question's own words: a bar reading "1 question" would
 * be a thing to open to find out what it is, and the point of folding it was to stop looking at it.
 *
 * Tinted rather than muted, because this is not a closed detail -- something is waiting on the
 * reader, and a row the same colour as the border would read as having gone away.
 */
function FoldedQuestion({
  question,
  name,
  total,
  missing,
  pending,
  error,
  onOpen,
}: {
  question: FramedQuestion;
  name: string;
  total: number;
  missing: number;
  pending: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`Reopen ${name}: ${question.question}`}
      // The refusal's own sentence, which is too long for the row and does not need to be on it:
      // it is already on screen in full the moment this reopens, which is the only place the
      // reader can act on it anyway.
      title={error ?? "Reopen the question"}
      className={`mb-3 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
        error
          ? "border-destructive/50 bg-destructive/5 hover:bg-destructive/10 active:bg-destructive/15"
          : "border-primary/40 bg-primary/5 hover:bg-primary/10 active:bg-primary/15"
      }`}
    >
      {pending ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
      ) : (
        <ChevronDown className={`size-4 shrink-0 ${error ? "text-destructive" : "text-primary"}`} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 text-foreground">
        {question.question}
      </span>
      {/* What reopening would be FOR, in the words the open panel uses for the same fact. */}
      <span
        className={`shrink-0 text-(length:--agent-panel-fs-sidebar-meta,13px) ${
          error ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {error ? "Not sent" : foldedStatus(total, missing)}
      </span>
    </button>
  );
}

/** The folded row's right-hand word: what answering still needs, or that it does not. */
function foldedStatus(total: number, missing: number): string {
  if (missing === 0) return total > 1 ? "All answered" : "Answered";
  if (total === 1) return "Unanswered";
  return `${missing} of ${total} left`;
}

/** What is left to do, in the place a disabled Submit button cannot say it. */
function hintText(total: number, missing: number, hint = "Choose an option, or type your own"): string {
  if (missing === 0) return total > 1 ? "All answered" : "";
  if (total === 1) return hint;
  return `${missing} of ${total} still to answer`;
}

/**
 * The strip naming every question of the call.
 *
 * The same job the terminal dialog's tab row does, and the reason paging is legible at all: with
 * one question on screen, this is what says how many there are, which are done, and how to reach
 * one without stepping through the others.
 */
function QuestionTabs({
  questions,
  answered,
  shown,
  onGo,
}: {
  questions: readonly FramedQuestion[];
  answered: readonly boolean[];
  shown: number;
  onGo: (at: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {questions.map((question, index) => {
        const here = index === shown;
        return (
          <button
            key={index}
            type="button"
            onClick={() => onGo(index)}
            aria-current={here ? "step" : undefined}
            aria-label={`Question ${index + 1} of ${questions.length}: ${question.question}`}
            className={`flex h-6 max-w-[10rem] items-center gap-1 rounded-md px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) transition-colors ${
              here ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {answered[index] ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : null}
            <span className="truncate">{question.header ?? `Q${index + 1}`}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One step of the pager. Hidden from the reader when there is nowhere to step. */
function Step({
  label,
  at,
  inert,
  onClick,
  children,
}: {
  label: string;
  at: boolean;
  inert: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inert || !at}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}
