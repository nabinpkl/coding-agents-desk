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

import { useCallback, useEffect, useState } from "react";
import type { TmuxQuestionAnswer, TmuxQuestionOutcome, TmuxQuestionRefusal } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { AskUserQuestionItem, OpenAskUserQuestion } from "@/app/askUserQuestion";
import {
  chooseOption,
  emptyDrafts,
  isAnswered,
  toAnswers,
  writeOther,
  type QuestionDraft,
} from "@/features/session-view/composer/questionAnswers";

/** The one call this needs, named so a test stands in for it without a whole data source. */
export interface TmuxQuestionSender {
  answerTmuxQuestion: (
    session: SessionAddress,
    answers: readonly TmuxQuestionAnswer[],
  ) => Promise<TmuxQuestionOutcome>;
}

/** What a refusal means, said the way the reader's own situation reads. */
export function tmuxQuestionReasonText(reason: TmuxQuestionRefusal): string {
  switch (reason) {
    case "no-pane":
      return "this session is not running in a terminal this panel can reach";
    case "tmux-unavailable":
      return "tmux did not answer";
    case "no-dialog":
      return "the question is no longer open in the terminal; it may have been answered there";
    case "wrong-dialog":
      return "the terminal is showing a different question, so nothing was sent";
    case "wrong-option":
      return "the options in the terminal do not match the ones here, so nothing was sent";
    case "pane-stalled":
      return "the terminal stopped redrawing partway through; answer it there instead";
    case "still-open":
      return "the question did not close, so it cannot be reported as answered";
  }
}

export function useTmuxQuestion(
  feed: TmuxQuestionSender,
  session: SessionAddress,
  question: OpenAskUserQuestion | null,
) {
  const questions: AskUserQuestionItem[] = question?.questions ?? [];
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => emptyDrafts(questions));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new call starts a fresh draft. Keyed on the callId rather than on the array, which is a new
  // object on every render of the feed.
  useEffect(() => {
    setDrafts(emptyDrafts(question?.questions ?? []));
    setError(null);
  }, [question?.callId]);

  const choose = useCallback((at: number, index: number) => {
    setError(null);
    setDrafts((current) => chooseOption(current, at, index, questions[at]?.multiSelect === true));
  }, [questions]);

  const write = useCallback((at: number, text: string) => {
    setError(null);
    setDrafts((current) => writeOther(current, at, text, questions[at]?.multiSelect === true));
  }, [questions]);

  const answers = toAnswers(questions, drafts);
  const submit = useCallback(async () => {
    if (!answers) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await feed.answerTmuxQuestion(session, answers);
      if (outcome.answered) return;
      setError(tmuxQuestionReasonText(outcome.reason));
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
    drafts,
    pending,
    error,
    /** Whether every question has something to send, which is what the dialog needs to finish. */
    canSubmit: questions.length > 0 && drafts.every(isAnswered),
    choose,
    write,
    submit,
  };
}
