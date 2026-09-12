// The answers a reader is building for an open AskUserQuestion, before any of them is sent.
//
// A local draft rather than a mirror of the dialog, and that is the whole difference from the
// window path next door. The Claude Desktop panel is a live surface somebody else may be looking
// at, so every click there is pushed at once and read back. A tmux dialog is answered by
// keystrokes that cannot be taken back -- a digit on a single-select question selects, marks and
// submits in one press -- so the reader composes here, sees all of it, and commits once.
//
// The other half of that choice is recovery. Text a person typed lives in this draft until the
// operation carrying it succeeds, so a refusal puts it back in the field they wrote it in rather
// than leaving it somewhere that no longer exists.

import type { TmuxQuestionAnswer } from "@agentdesk/agent-feed-wire";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";

/** What one question has been answered with so far. */
export interface QuestionDraft {
  /**
   * Chosen option indices, in the order they were picked.
   *
   * Order rather than a set because that is the order the dialog reports them back in, so a
   * reader who checks C then A sees "C, A" in the review either way.
   */
  chosen: number[];
  other: string;
}

export function emptyDrafts(questions: readonly AskUserQuestionItem[]): QuestionDraft[] {
  return questions.map(() => ({ chosen: [], other: "" }));
}

/**
 * One draft per question, keeping every answer already given.
 *
 * Needed because a call's questions ARRIVE, rather than existing all at once: the tool_use's input
 * streams into the transcript, so the panel can hold three questions of four and then a moment
 * later hold the fourth. Measured on a live pane -- a draft built from the first reading stayed
 * three long, and every click on the fourth question was dropped by the write, which then read as
 * the surface ignoring that question entirely.
 *
 * Not a reset, which is the other half of it: the answers already given are to questions that have
 * not changed, and rebuilding would throw them away each time another one appeared.
 */
export function alignDrafts(
  drafts: readonly QuestionDraft[],
  count: number,
): QuestionDraft[] {
  if (drafts.length === count) return [...drafts];
  return Array.from({ length: count }, (_, at) => drafts[at] ?? { chosen: [], other: "" });
}

/**
 * Picks or unpicks one option.
 *
 * A single-select question replaces whatever was there, and picking an option clears that
 * question's free text: the dialog takes one answer per question, and leaving both set would send
 * a request the sidecar refuses as a contradiction.
 */
export function chooseOption(
  drafts: readonly QuestionDraft[],
  at: number,
  index: number,
  multiSelect: boolean,
): QuestionDraft[] {
  return drafts.map((draft, position) => {
    if (position !== at) return draft;
    if (!multiSelect) {
      return draft.chosen[0] === index
        ? { chosen: [], other: draft.other }
        : { chosen: [index], other: "" };
    }
    const chosen = draft.chosen.includes(index)
      ? draft.chosen.filter((entry) => entry !== index)
      : [...draft.chosen, index];
    return { chosen, other: draft.other };
  });
}

/**
 * Writes this question's free text.
 *
 * On a single-select question text and an option are alternatives, so typing clears the pick the
 * same way picking clears the text. On a multi-select one they are not: the dialog carries both,
 * and the answer reads "ECHO, and something else".
 */
export function writeOther(
  drafts: readonly QuestionDraft[],
  at: number,
  text: string,
  multiSelect: boolean,
): QuestionDraft[] {
  return drafts.map((draft, position) =>
    position === at
      ? { chosen: multiSelect || text.length === 0 ? draft.chosen : [], other: text }
      : draft
  );
}

/** Whether this question has anything to send. */
export function isAnswered(draft: QuestionDraft): boolean {
  return draft.chosen.length > 0 || draft.other.trim().length > 0;
}

/**
 * The answers, in wire shape, or null when one of the questions has none.
 *
 * Null rather than a partial set. The dialog submits every question at once and will not finish
 * while one is unanswered, so sending a short set would spend the reader's other answers on a
 * submit that cannot land.
 */
export function toAnswers(
  questions: readonly AskUserQuestionItem[],
  drafts: readonly QuestionDraft[],
): TmuxQuestionAnswer[] | null {
  if (questions.length !== drafts.length) return null;
  const answers: TmuxQuestionAnswer[] = [];
  for (const [at, question] of questions.entries()) {
    const draft = drafts[at]!;
    if (!isAnswered(draft)) return null;
    answers.push({
      question: question.question,
      // The label travels with the index so the sidecar can check the row it is about to press
      // says what this reader was looking at when they picked it.
      chosen: draft.chosen.map((index) => ({
        index,
        label: question.options[index]?.label ?? "",
      })),
      other: draft.other.trim(),
    });
  }
  return answers;
}
