"use client";

// The AskUserQuestion mirror's tmux half: composing every answer locally, then sending them as one
// operation that drives the dialog standing in the session's pane.
//
// The opposite discipline to the window half next door, on purpose. That one pushes each click at
// once because the panel it mirrors is a live surface somebody may be looking at. A tmux dialog is
// driven by keystrokes that cannot be taken back -- one digit on a single-select question selects,
// marks and submits -- so a per-click mirror would commit a reader's first tap before they had
// read the second option. Everything is drafted here and committed once.
//
// What a refusal does is the other half of that. The draft is left exactly as it was, so the words
// somebody typed are still in the field they wrote them in, and the outcome's own `keptText` is
// written back over it -- which is a no-op when they agree and a recovery when they do not.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TmuxQuestionAnswer,
  TmuxQuestionOutcome,
  TmuxQuestionPoint,
  TmuxQuestionPointOutcome,
  TmuxQuestionRefusal,
  TmuxQuestionState,
} from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { AskUserQuestionItem, OpenAskUserQuestion } from "@/app/askUserQuestion";
import {
  adoptPaneState,
  alignDrafts,
  chooseOption,
  emptyDrafts,
  isAnswered,
  paneCursorFrom,
  toAnswers,
  writeOther,
  type QuestionDraft,
} from "@/features/session-view/composer/question/questionAnswers";

/** The one call this needs, named so a test stands in for it without a whole data source. */
export interface TmuxQuestionSender {
  answerTmuxQuestion: (
    session: SessionAddress,
    answers: readonly TmuxQuestionAnswer[],
  ) => Promise<TmuxQuestionOutcome>;
  /**
   * Moves the terminal's own cursor onto an option, answering nothing.
   *
   * Separate from the answer call because the two are allowed to do different things to a pane,
   * and the separation is enforced on the sidecar side: this one may press only arrows, so it
   * cannot finish the dialog however wrong it is about which row to land on.
   */
  pointTmuxQuestion: (
    session: SessionAddress,
    point: TmuxQuestionPoint,
  ) => Promise<TmuxQuestionPointOutcome>;
}

/**
 * What a refusal means, said the way the reader's own situation reads.
 *
 * Two rules, both learned by getting them wrong. It says what was OBSERVED and never why: the old
 * `no-dialog` sentence offered "it may have been answered there", which was a guess presented as
 * the cause and was false both times a reader hit it. And whether anything landed comes from
 * `sent` rather than from the reason, because the driver presses as it walks: a refusal can leave
 * a question answered and a box ticked in the terminal, and telling somebody nothing was sent is
 * worse than telling them nothing.
 */
export function tmuxQuestionReasonText(reason: TmuxQuestionRefusal, sent: boolean): string {
  const already = sent
    ? ", and some of these answers may already have landed there"
    : ", so nothing was sent";
  switch (reason) {
    // Neither of these two can have pressed anything: there was nowhere to press.
    case "no-pane":
      return "this session is not running in a terminal this panel can reach";
    case "tmux-unavailable":
      return "tmux did not answer";
    case "no-dialog":
      return `the terminal is not showing this question${already}`;
    case "wrong-dialog":
      return `the terminal is showing a different question${already}`;
    case "wrong-option":
      return `the options in the terminal do not match the ones here${already}`;
    case "pane-stalled":
      return `the terminal stopped redrawing partway through${already}`;
    case "still-open":
      // The one reason that always follows a full set of presses, so `already` would be redundant.
      return "the question did not close, so it cannot be reported as answered; what you chose may"
        + " already be standing in the terminal";
  }
}

export function useTmuxQuestion(
  feed: TmuxQuestionSender,
  session: SessionAddress,
  question: OpenAskUserQuestion | null,
  /**
   * What the dialog in the session's own terminal holds right now, or null when nothing is
   * watching it. Null is the ordinary case until the reader touches the question: opening a
   * thread does not attach the pane, and this arrives with the attachment.
   */
  pane: TmuxQuestionState | null = null,
) {
  const questions: AskUserQuestionItem[] = question?.questions ?? [];
  const count = questions.length;
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => emptyDrafts(questions));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which questions this reader has answered here and not yet sent.
   *
   * The guard on following the pane, and the same rule the composer mirror applies to text: a
   * draft is newer than any screen, so a reading may fill a question nobody has touched and never
   * overwrite one somebody has. Per question rather than one flag, because a call is answered a
   * question at a time and the ones still blank are exactly the ones worth filling.
   */
  const touched = useRef(new Set<number>());

  // A new call starts a fresh draft. Keyed on the callId rather than on the array, which is a new
  // object on every render of the feed.
  useEffect(() => {
    setDrafts(emptyDrafts(question?.questions ?? []));
    touched.current = new Set();
    setError(null);
  }, [question?.callId]);

  // Follows the terminal, for questions this reader has not answered here. Somebody at that
  // keyboard may have been part-way through the dialog before the panel was opened on it.
  useEffect(() => {
    if (!pane) return;
    setDrafts((current) =>
      adoptPaneState(
        alignDrafts(current, count),
        questions,
        pane,
        (at) => !touched.current.has(at),
      )
    );
    // `questions` is a fresh array on every render of the feed, so the call is keyed by its id.
  }, [pane, question?.callId]);

  // Every write aligns first, because a call's questions arrive rather than existing all at once:
  // the tool_use's input streams into the transcript, and a draft built from the first reading is
  // short until the last question lands. `alignDrafts` keeps what has been answered already.
  const choose = useCallback((at: number, index: number) => {
    setError(null);
    touched.current.add(at);
    setDrafts((current) =>
      chooseOption(alignDrafts(current, count), at, index, questions[at]?.multiSelect === true)
    );
    // And the other way: put the terminal's own cursor on the row this reader just looked at, so
    // somebody watching that pane sees where the panel has got to. Deliberately not awaited and
    // deliberately silent -- the draft above is the answer, this is only a highlight, and a
    // terminal that refuses or is not there must not stop anybody answering in the panel.
    const label = questions[at]?.options[index]?.label;
    if (label === undefined) return;
    void feed.pointTmuxQuestion(session, {
      questions: questions.map((entry) => entry.question),
      at,
      option: index,
      label,
    }).catch(() => {});
  }, [count, feed, questions, session]);

  const write = useCallback((at: number, text: string) => {
    setError(null);
    touched.current.add(at);
    setDrafts((current) =>
      writeOther(alignDrafts(current, count), at, text, questions[at]?.multiSelect === true)
    );
  }, [count, questions]);

  const aligned = alignDrafts(drafts, count);
  const answers = toAnswers(questions, aligned);
  const submit = useCallback(async () => {
    if (!answers) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await feed.answerTmuxQuestion(session, answers);
      if (outcome.answered) return;
      setError(tmuxQuestionReasonText(outcome.reason, outcome.sent));
      // Nothing typed is dropped by a refusal. The draft already holds it; this writes the
      // sidecar's own copy back over it, so the two cannot quietly disagree about what was sent.
      setDrafts((current) =>
        current.map((draft, at) => {
          const kept = outcome.keptText.find((entry) => entry.question === questions[at]?.question);
          return kept ? { ...draft, other: kept.text } : draft;
        })
      );
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setPending(false);
    }
  }, [answers, feed, questions, session]);

  return {
    questions,
    drafts: aligned,
    /**
     * Where the terminal's own cursor is, for drawing only.
     *
     * Never folded into `drafts`: the pane routinely holds a cursor on one row and an answer on
     * another, so a panel that merged them would move somebody's answer to whatever row they last
     * walked past, and `canSubmit` would go true off a highlight.
     */
    paneCursor: paneCursorFrom(questions, pane),
    pending,
    error,
    /** Whether every question has something to send, which is what the dialog needs to finish. */
    canSubmit: count > 0 && aligned.every(isAnswered),
    choose,
    write,
    submit,
  };
}
