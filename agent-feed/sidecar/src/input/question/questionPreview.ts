/**
 * Answering a TWO-COLUMN question: the shape a single-select question with option previews draws.
 *
 * Its own answerer because almost nothing about the one-column shape survives here. Every rule
 * below was measured by hand on 2026-09-16 against Claude Code 2.1.273, on 80x24 and 120x30 panes.
 *
 *   A DIGIT only MOVES THE CURSOR. It does not select, it does not mark the tab, and it does not
 *   advance -- which is all three of the things that same key does on a one-column single-select
 *   question. ENTER is what selects, and it marks the tab answered and advances in the one press.
 *   So this walks the cursor with the arrows and commits with Enter, where `answerOnce` next door
 *   presses one digit and is done.
 *
 *   There is NO free-text row. What a reader types instead goes in the `Notes` field under the
 *   preview panel, opened with `n` from anywhere on the question. Once that field has the keyboard
 *   it takes EVERY key as text: Tab, both side arrows and the digits were all measured typed
 *   rather than obeyed. Enter is the one way out, and it commits the note, marks the tab answered
 *   and advances exactly as choosing a row does.
 *
 *   The field opens with its cursor at the START of whatever it already holds -- measured by
 *   typing one character and watching it land in front of the rest -- so replacing somebody's note
 *   means `END_OF_LINE` first and then one backspace per character. Without that first key a
 *   backspace deletes nothing at all and the new words are simply prepended to the old ones.
 *
 * A note and a chosen option can both stand on one question: the review screen showed the chosen
 * label with the note riding along. This still refuses the pair, because the panel never sends
 * one -- a single-select draft treats text and an option as alternatives -- and answering both
 * would take two trips through the dialog to do something nobody asked for.
 */
import type { TmuxQuestionAnswer, TmuxQuestionRefusal } from "@agentdesk/agent-feed-wire";
import { saysTheSame } from "@/input/rewindPicker";
import { isPlaceholder, type QuestionDialog } from "@/input/question/questionDialog";
import {
  END_OF_LINE,
  moveCursor,
  press,
  reread,
  RETURN,
  RUBOUT,
  sanitised,
  type QuestionRuntime,
} from "@/input/question/questionKeys";

/** What opens the `Notes` field, which the footer advertises and no digit reaches. */
const OPEN_NOTES = "n";

/** Leaves one two-column question answered, having advanced off it. */
export async function answerPreviewQuestion(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  dialog: QuestionDialog,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const answer = answers[at]!;
  if (answer.other.length > 0) {
    // One answer per question here, so text and an option together is a contradiction rather than
    // something to resolve by picking one.
    if (answer.chosen.length > 0) return "wrong-option";
    return await writeNotes(pane, answers, at, dialog, runtime);
  }
  if (answer.chosen.length !== 1) return "wrong-option";

  const landed = await moveCursor(pane, answers, at, answer.chosen[0]!.index, runtime);
  if (!landed) return "wrong-dialog";
  // Selects, marks the tab and advances, all on this one press.
  return (await press(pane, RETURN, runtime)) ? null : "pane-stalled";
}

/** Replaces what the `Notes` field holds with this question's text, and commits it. */
async function writeNotes(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  dialog: QuestionDialog,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  // Only when it does not already have the keyboard: pressing `n` at a field that does types an
  // `n` into somebody's note instead of opening anything.
  if (!dialog.notes!.focused && !(await press(pane, OPEN_NOTES, runtime))) return "pane-stalled";
  const opened = await reread(pane, answers, at, runtime);
  if (!opened?.notes?.focused) return "wrong-dialog";

  // A field showing Claude's own prompt holds nothing, so there is nothing to backspace over.
  const held = isPlaceholder(opened.notes.text) ? "" : opened.notes.text;
  if (held.length > 0 && !(await press(pane, END_OF_LINE + RUBOUT.repeat(held.length), runtime))) {
    return "pane-stalled";
  }
  // Sanitised once and checked against the same string, because what the field ends up holding is
  // what was SENT. Checking against the original would fail every answer carrying an escape.
  const wanted = sanitised(answers[at]!.other);
  if (!(await press(pane, wanted, runtime))) return "pane-stalled";

  const after = await reread(pane, answers, at, runtime);
  if (!after?.notes) return "wrong-dialog";
  // The field cuts a long note to its own width, so only its start is recoverable -- the same
  // prefix check every label gets. What this catches is a clear that under-counted, which shows up
  // as the old text still standing in front of the new.
  if (!saysTheSame(after.notes.text, wanted)) return "wrong-option";
  // Commits the note, marks the tab and advances. Nothing further is needed to leave the question.
  return (await press(pane, RETURN, runtime)) ? null : "pane-stalled";
}
