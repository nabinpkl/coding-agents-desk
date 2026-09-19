/**
 * A question dialog on a pane, in the shape a panel following along can use.
 *
 * The opposite direction from `questionAnswer.ts`, which takes answers and presses keys until the
 * dialog holds them. This takes the dialog as it stands and says what it holds, so a reader
 * answering in the panel sees what somebody at that keyboard has already chosen instead of a blank
 * draft that would overwrite it.
 *
 * Only STATE crosses. The question's text, its options and their descriptions are the tool call,
 * which the panel already holds in full and untruncated -- where a screen has them wrapped, cut to
 * the pane width, and indistinguishable from the description lines under them. Sending the screen's
 * version of content the panel already has would be offering a worse copy of it.
 */
import type { TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import {
  isPlaceholder,
  otherRowIndex,
  type QuestionDialog,
} from "@/input/question/questionDialog";

export function questionStateFrom(dialog: QuestionDialog): TmuxQuestionState {
  const other = otherRowIndex(dialog);
  // Everything before the free-text row is the tool's own options. The inline button sits outside
  // that run, and is filtered anyway rather than relied on to be.
  const options = dialog.rows
    .slice(0, other < 0 ? dialog.rows.length : other)
    .filter((row) => !row.button)
    .map((row) => ({
      label: row.text,
      // One field for two shapes, because a panel asks one question of them: is this the answer.
      // A multi-select row carries its own box; a single-select one marks its answer with a
      // trailing tick and leaves the cursor somewhere else entirely.
      marked: row.ticked ?? row.chosen,
      cursor: row.cursor,
    }));
  const free = other >= 0 ? dialog.rows[other] : undefined;
  return {
    question: dialog.question,
    review: dialog.review,
    multiSelect: dialog.multiSelect,
    // The Submit entry is dropped: it is a control, not a question, and a panel counting tabs
    // against the call's own questions would be one out on every multi-question dialog.
    tabs: dialog.tabs
      .filter((tab) => !tab.submit)
      .map((tab) => ({ label: tab.label, answered: tab.answered })),
    options,
    // Claude's own prompt is not somebody's words, and a panel that adopted it would put
    // "Type something." in a reader's field.
    other: free && !isPlaceholder(free.text) ? free.text : null,
  };
}
