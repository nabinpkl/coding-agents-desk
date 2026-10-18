/**
 * Putting the pane's cursor on one option, without answering anything.
 *
 * The live half of the question mirror, and the counterpart to `questionMirrorState.ts`: that one
 * reads where the cursor is so the panel can draw it, and this one moves it so the terminal can
 * draw what the panel is looking at. Between them a reader and somebody at that keyboard are
 * looking at the same row.
 *
 * **It may press arrows and nothing else, and that is the whole reason it is a separate driver
 * from `questionAnswer.ts` rather than a flag on it.** A digit on a single-select question
 * selects the row, marks the tab answered and advances to the next question in one press -- so
 * the obvious way to put a cursor on option two is also the one way to answer the question with
 * it. Enter commits, Escape destroys the call and any text typed into it. What is left is Up and
 * Down within a question and Left and Right between them, which move and commit nothing, and
 * `goTo` and `moveCursor` already walk with exactly those while re-reading the screen between
 * presses.
 *
 * So a bug here costs a highlight in the wrong place. A bug in the same code written as part of
 * the answerer would cost somebody's answer, which is why the key vocabulary is narrowed by which
 * functions this file imports rather than by remembering not to call the others.
 *
 * Serialised through `inTurn` like every other writer to a pane, so this and a reader committing
 * their answers cannot be pressing into one terminal at the same moment.
 */
import type { TmuxQuestionPoint, TmuxQuestionPointOutcome, TmuxQuestionRefusal } from "@agentdesk/agent-feed-wire";
import { captureTmuxQuestionView, hexSend, TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";
import { liveTmuxSession } from "@/terminal/agentTerminalService";
import { inTurn } from "@/input/tmuxComposerPanes";
import { saysTheSame } from "@/input/rewindPicker";
import { otherRowIndex, questionDialog, type QuestionDialog, type QuestionRow } from "@/input/question/questionDialog";
import { goTo, moveCursor, type QuestionAsked, type QuestionRuntime } from "@/input/question/questionKeys";

const LIVE: QuestionRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  // The same reader the answerer uses, which looks above the screen: a dialog with long
  // descriptions pushes its own opening rule and tab row into the scrollback.
  screen: captureTmuxQuestionView,
  send: hexSend,
};

/** Moves the cursor of `sessionId`'s open dialog onto one option, answering nothing. */
export async function pointTmuxQuestion(
  sessionId: string,
  point: TmuxQuestionPoint,
  runtime: QuestionRuntime = LIVE,
): Promise<TmuxQuestionPointOutcome> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await runtime.pane(sessionId);
      if (!pane) return refused("no-pane");
      const reason = await walk(pane, point, runtime);
      return reason === null ? { pointed: true } : refused(reason);
    } catch (error) {
      return refused(error instanceof TmuxUnavailable ? "tmux-unavailable" : "no-pane");
    }
  });
}

async function walk(
  pane: string,
  point: TmuxQuestionPoint,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const asked: QuestionAsked[] = point.questions.map((question) => ({ question }));
  // Bounded before anything is read, because an out-of-range question would otherwise be refused
  // only after `goTo` had spent its whole step budget looking for a tab that cannot exist.
  if (point.at < 0 || point.at >= asked.length) return "wrong-dialog";
  if (point.option < 0) return "wrong-option";

  const opened = questionDialog(await runtime.screen(pane));
  if (!opened) return "no-dialog";
  // The same agreement the answerer insists on: a dialog with a different number of questions is
  // not the call this request describes, and every index below would mean something else on it.
  if (opened.tabs.filter((tab) => !tab.submit).length !== asked.length) return "wrong-dialog";

  const dialog = await goTo(pane, asked, point.at, runtime);
  if (!dialog) return "wrong-dialog";

  // Position picks the row and text decides whether to move to it, which is the rule the whole
  // module shares. It matters less here than it does for an answer -- a cursor on the wrong row
  // is a wrong highlight, not a wrong answer -- but a mirror that silently points somewhere else
  // is worse than one that admits it is behind.
  const row = optionRows(dialog)[point.option];
  if (!row || !saysTheSame(row.text, point.label)) return "wrong-option";

  // The option index IS the row index: the tool's own options are the leading run of rows in both
  // dialog shapes, with the free-text row and the inline button after them.
  return (await moveCursor(pane, asked, point.at, point.option, runtime)) ? null : "wrong-dialog";
}

/**
 * The rows that are the tool call's own options, in both shapes.
 *
 * One-column questions put a free-text row last and multi-select ones an inline button after it;
 * a two-column question has neither, and every row it draws is an option.
 */
function optionRows(dialog: QuestionDialog): QuestionRow[] {
  const other = otherRowIndex(dialog);
  return other < 0 ? dialog.rows.filter((row) => !row.button) : dialog.rows.slice(0, other);
}

function refused(reason: TmuxQuestionRefusal): TmuxQuestionPointOutcome {
  return { pointed: false, reason };
}
