/**
 * A question dialog on a pane, in the shape a panel following along can use.
 *
 * The opposite direction from `questionAnswer.ts`, which takes answers and presses keys until the
 * dialog holds them. This takes the dialog as it stands and says what it holds, so a reader
 * answering in the panel sees what somebody at that keyboard has already chosen instead of a blank
 * draft that would overwrite it.
 *
 * What the panel follows by is the STATE. The question's text, its options and their descriptions
 * are the tool call, which the panel holds in full and untruncated wherever it has one -- where a
 * screen has them wrapped, cut to the pane width, and indistinguishable from the description lines
 * under them. The screen's copy still crosses (`prompt`, `detail`), for the turn whose tool call
 * the panel never received; see `TmuxQuestionState`.
 */
import type { TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import { isPlaceholder, otherRowIndex, type QuestionDialog } from "@/input/question/questionDialog";

export function questionStateFrom(dialog: QuestionDialog): TmuxQuestionState {
  const other = otherRowIndex(dialog);
  // Everything before the free-text row is the tool's own options. The inline button sits outside
  // that run, and is filtered anyway rather than relied on to be.
  const options = dialog.rows
    .slice(0, other < 0 ? dialog.rows.length : other)
    .filter((row) => !row.button)
    .map((row) => ({
      label: row.text,
      detail: row.detail,
      // One field for two shapes, because a panel asks one question of them: is this the answer.
      // A multi-select row carries its own box; a single-select one marks its answer with a
      // trailing tick and leaves the cursor somewhere else entirely.
      marked: row.ticked ?? row.chosen,
      cursor: row.cursor,
    }));
  // A two-column question has no free-text ROW: what it offers instead is the `Notes` field under
  // its preview panel, which is the same thing to a panel reading this and a different thing
  // entirely to the driver pressing keys at it.
  const free = other >= 0 ? dialog.rows[other]!.text : dialog.notes?.text;
  return {
    question: dialog.question,
    prompt: dialog.prompt,
    review: dialog.review,
    multiSelect: dialog.multiSelect,
    // The Submit entry is dropped: it is a control, not a question, and a panel counting tabs
    // against the call's own questions would be one out on every multi-question dialog.
    tabs: dialog.tabs.filter((tab) => !tab.submit).map((tab) => ({ label: tab.label, answered: tab.answered })),
    options,
    // Claude's own prompt is not somebody's words, and a panel that adopted it would put
    // "Type something." in a reader's field.
    other: free !== undefined && !isPlaceholder(free) ? free : null,
  };
}
