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

import type { TmuxQuestionAnswer, TmuxQuestionState } from "@agentdesk/agent-feed-wire";
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

/**
 * Whether a label read off a screen names this option.
 *
 * A PREFIX check, because a long label wraps in the terminal onto a row indented exactly like a
 * description, so what a screen can give back is only its start. The same rule the sidecar applies
 * before it presses anything, applied here for the same reason: position says which row, and text
 * says whether it is the row this answer was written for.
 */
export function sameLabel(onScreen: string, whole: string): boolean {
  const seen = onScreen.trim();
  return seen.length > 0 && whole.trim().startsWith(seen);
}

/**
 * The drafts, with what the terminal already holds folded into the question it is showing.
 *
 * The other direction of the mirror. Somebody at that keyboard may have answered a question before
 * the panel was ever opened on it, and a panel that drew an empty draft over the top of their
 * choices would be inviting a reader to overwrite work that is already done.
 *
 * Only the question the pane is SHOWING, because that is the only one whose rows it reports: the
 * tab row says which others are answered but not with what, and a draft filled from "answered"
 * alone would be a guess.
 *
 * `untouched` is the guard, and it is the same rule the composer mirror uses for text: anything
 * this reader has chosen here and not yet sent is newer than any screen, so the pane may not
 * overwrite it.
 */
export function adoptPaneState(
  drafts: readonly QuestionDraft[],
  questions: readonly AskUserQuestionItem[],
  pane: TmuxQuestionState,
  untouched: (at: number) => boolean,
): QuestionDraft[] {
  const shown = pane.question;
  if (shown === null) return [...drafts];
  const at = questions.findIndex((entry) => sameLabel(shown, entry.question));
  if (at < 0 || at >= drafts.length || !untouched(at)) return [...drafts];

  const chosen: number[] = [];
  for (const option of pane.options) {
    if (!option.marked) continue;
    const index = questions[at]!.options.findIndex((entry) => sameLabel(option.label, entry.label));
    if (index >= 0 && !chosen.includes(index)) chosen.push(index);
  }
  const other = pane.other ?? "";
  // A dialog nobody has answered yet says nothing this side does not already know, and adopting
  // it would clear a draft on every reading the pane sends.
  if (chosen.length === 0 && other.length === 0) return [...drafts];
  return drafts.map((draft, position) => (position === at ? { chosen, other } : draft));
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

/**
 * Which option the session's own terminal has its cursor on, or null when it has none on one.
 *
 * Kept OUT of the draft on purpose, and this is the distinction the whole live mirror turns on. A
 * cursor is the row somebody is looking at; a draft is the answer they have given. The terminal
 * draws both at once and they are routinely different -- an answered single-select question puts
 * a trailing tick on the chosen row and leaves the cursor back on row one, so a panel that folded
 * the cursor into `chosen` would move the reader's own answer to whatever row they last walked
 * past. Worse, `isAnswered` is computed off `chosen`, so a bare highlight would light up Submit
 * for a question nobody has answered.
 *
 * So this returns a place to draw a ring, and nothing that can be sent anywhere.
 *
 * Resolved back to the tool call's own indices rather than reported as screen positions: the
 * label is matched by prefix, because a long one wraps in the terminal and only its start comes
 * back. Null whenever that match fails, which is the honest answer -- a ring drawn on a guess
 * would be indistinguishable from one drawn on a reading.
 */
export function paneCursorFrom(
  questions: readonly AskUserQuestionItem[],
  pane: TmuxQuestionState | null,
): { at: number; option: number } | null {
  const shown = pane?.question;
  if (!pane || shown === null || shown === undefined) return null;
  const at = questions.findIndex((entry) => sameLabel(shown, entry.question));
  if (at < 0) return null;
  // The free-text row and the inline button are not options, and `TmuxQuestionState` has already
  // dropped them, so a cursor parked on one of those shows up here as no option having it.
  const on = pane.options.find((option) => option.cursor);
  if (!on) return null;
  const option = questions[at]!.options.findIndex((entry) => sameLabel(on.label, entry.label));
  return option < 0 ? null : { at, option };
}

/**
 * Which question of the call the terminal is showing, or null when that cannot be told.
 *
 * Separate from `paneCursorFrom` because the two answer different things and one of them is
 * routinely null while the other is not: the cursor can be parked on a multi-select question's
 * inline Submit button or on its free-text row, neither of which is an option, and the pane is
 * still plainly on that question. A surface that derived "which question" from the cursor would
 * lose the pane every time somebody walked past the end of the options.
 *
 * This is the half that was missing when the mirror first shipped, and the failure was total
 * rather than subtle: the reader's panel sat on question one while the terminal had moved to
 * question two, so every cursor reading was about a question the panel was not showing, no ring
 * was ever drawn, and arrowing in the terminal appeared to do nothing at all.
 */
export function paneQuestionAt(
  questions: readonly AskUserQuestionItem[],
  pane: TmuxQuestionState | null,
): number | null {
  const shown = pane?.question;
  if (!pane || shown === null || shown === undefined) return null;
  const at = questions.findIndex((entry) => sameLabel(shown, entry.question));
  return at < 0 ? null : at;
}
