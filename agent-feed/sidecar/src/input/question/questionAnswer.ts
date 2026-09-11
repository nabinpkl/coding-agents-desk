/**
 * Answering Claude's AskUserQuestion dialog in a tmux pane, from a set of answers.
 *
 * The driver half; `questionDialog.ts` reads the screen this presses keys at. Everything about
 * which key does what was measured by hand on 2026-09-11 against Claude Code 2.1.268, and the
 * surprises are all in the same place: **one key does three different things depending on the
 * shape of the question and where the cursor is.**
 *
 *   A DIGIT on a single-select question selects that option, marks the tab answered, and ADVANCES
 *   to the next tab in one press. No Enter, no confirmation. Answering the last question advances
 *   to the review screen.
 *
 *   The same digit on a multi-select question TOGGLES that option, moves nothing, and advances
 *   nothing. Enter and Space do the same toggle on whatever row the cursor is on -- so Enter is
 *   not a commit here, and pressing it to "confirm" un-ticks the reader's own choice.
 *
 *   The same digit on the FREE-TEXT row does yet a third thing: on a single-select question it
 *   moves the cursor there, and on a multi-select one it only ticks the row's box and leaves the
 *   cursor where it was. So the two shapes need different routes to the same typing position, and
 *   the multi-select one has to walk the cursor with arrows.
 *
 *   Once the cursor IS on the free-text row, digits stop being hotkeys and are typed, and so do
 *   the arrows -- Left and Right move the text cursor instead of the tab. Measured: a Right press
 *   meant to advance a tab did nothing at all. Tab is what leaves that row, onto the inline
 *   button under the options.
 *
 *   That inline button reads `Submit` when its question is the only one and `Next` when another
 *   follows, and Enter on it advances. It is the one measured way off a multi-select question
 *   that does not disturb what is ticked.
 *
 *   Left and Right step one tab and CLAMP rather than wrapping (measured against the review
 *   screen, which Right would not move past).
 *
 * Two decisions follow, and they are the ones to keep if this is rewritten:
 *
 * - **It never presses Escape.** The rewind picker aborts that way because a picker left open is
 *   a pane nobody can type into. Here Escape CANCELS THE WHOLE TOOL CALL and destroys any text
 *   the reader typed into a free-text row, with no record of it anywhere -- measured, and grepped
 *   for afterwards in the transcript, which never held it. A refusal therefore leaves the dialog
 *   exactly as it found it, which is the state a person can still finish at the keyboard, and
 *   hands the typed text back to the panel in the outcome.
 * - **Position picks the row; text decides whether to press it.** Every chosen index is checked
 *   against what its row says before any key goes out, and the driver finds its way between
 *   questions by matching the QUESTION TEXT rather than by counting tabs -- which is also what
 *   makes it work when somebody has already navigated the dialog by hand.
 */
import {
  bytesForRailKey,
  type TmuxQuestionAnswer,
  type TmuxQuestionOutcome,
  type TmuxQuestionRefusal,
} from "@agentdesk/agent-feed-wire";
import {
  captureTmuxPaneView,
  hexSend,
  TmuxUnavailable,
  type TmuxPaneView,
} from "@/terminal/tmux/tmuxSessions";
import { liveTmuxSession } from "@/terminal/agentTerminalService";
import { inTurn } from "@/input/tmuxComposerPanes";
import { saysTheSame } from "@/input/rewindPicker";
import {
  isPlaceholder,
  otherRowIndex,
  questionDialog,
  type QuestionDialog,
} from "@/input/question/questionDialog";

const UP = bytesForRailKey("up");
const DOWN = bytesForRailKey("down");
const LEFT = bytesForRailKey("left");
const RIGHT = bytesForRailKey("right");
const TAB = bytesForRailKey("tab");
const RETURN = "\r";
/** What a terminal sends for Backspace, which is DEL rather than BS. */
const RUBOUT = "";
/** The row the review screen offers, matched by label because its number moves with the screen. */
const SUBMIT = "Submit answers";

const REDRAW_LIMIT_MS = 4_000;
const REDRAW_POLL_MS = 25;
/**
 * How many reads any one walk may take.
 *
 * A bound on how long this may hold a pane, not on how far a cursor may travel: the tool caps a
 * call at four questions of four options, so every real walk here is a handful of steps and this
 * only stops a pane that has stopped moving from spinning the budget.
 */
const MAX_STEPS = 24;

/** Everything this needs from tmux, injected so the suite needs no tmux server. */
export interface QuestionRuntime {
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<TmuxPaneView>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
  /** Overridable so a test does not spend the live redraw budget proving a refusal. */
  redrawLimitMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const LIVE: QuestionRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  screen: captureTmuxPaneView,
  send: hexSend,
};

/**
 * Answers one session's open question dialog, every question in one operation.
 *
 * Takes the pane's turn the way a composer push does, so this and somebody typing cannot be
 * sending into one pane at once.
 */
export async function answerTmuxQuestion(
  sessionId: string,
  answers: readonly TmuxQuestionAnswer[],
  runtime: QuestionRuntime = LIVE,
): Promise<TmuxQuestionOutcome> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await runtime.pane(sessionId);
      if (!pane) return refused("no-pane", answers);
      const reason = await drive(pane, answers, runtime);
      return reason === null ? { answered: true } : refused(reason, answers);
    } catch (error) {
      // No Escape on the way out, deliberately: see the header. A dialog left standing is one the
      // reader can still finish, and the words they typed here go back in the outcome.
      return refused(error instanceof TmuxUnavailable ? "tmux-unavailable" : "no-pane", answers);
    }
  });
}

async function drive(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const opened = questionDialog(await runtime.screen(pane));
  if (!opened) return "no-dialog";
  // The dialog and the transcript have to be describing the same tool call. A count that disagrees
  // means the panel is answering something else, and every index below would land on the wrong row.
  if (opened.tabs.filter((tab) => !tab.submit).length !== answers.length) return "wrong-dialog";

  for (let at = 0; at < answers.length; at += 1) {
    const reason = await answerOne(pane, answers, at, runtime);
    if (reason) return reason;
  }
  return await submit(pane, answers, runtime);
}

/** Walks to one question and leaves it answered, with the cursor off the free-text row. */
async function answerOne(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const answer = answers[at]!;
  const dialog = await goTo(pane, answers, at, runtime);
  if (!dialog) return "wrong-dialog";

  const other = otherRowIndex(dialog);
  if (other < 0) return "wrong-dialog";
  // The free-text row is the last numbered one, so everything before it is the tool's own options.
  // That reading is not asserted here: the label check below is what tests it, because an index
  // landing on the free-text row would be checked against a label the row does not say.
  const options = dialog.rows.slice(0, other);
  for (const pick of answer.chosen) {
    const row = options[pick.index];
    if (!row || !saysTheSame(row.text, pick.label)) return "wrong-option";
  }

  return dialog.multiSelect
    ? await answerMany(pane, answers, at, dialog, runtime)
    : await answerOnce(pane, answers, at, dialog, runtime);
}

/** A single-select question: one press for an option, or the free-text route. */
async function answerOnce(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  dialog: QuestionDialog,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const answer = answers[at]!;
  const other = otherRowIndex(dialog);
  if (answer.other.length > 0) {
    // One answer per question here, so text and an option together is a contradiction rather than
    // something to resolve by picking one.
    if (answer.chosen.length > 0) return "wrong-option";
    const row = dialog.rows[other]!;
    // The digit moves the cursor onto the row on this shape of question, which is all it does.
    const moved = await press(pane, String(row.number), runtime);
    if (!moved) return "pane-stalled";
    const typed = await typeOther(pane, answers, at, runtime);
    if (typed) return typed;
    // Commits the text AND advances, measured. Nothing further is needed to leave the question.
    return (await press(pane, RETURN, runtime)) ? null : "pane-stalled";
  }
  if (answer.chosen.length !== 1) return "wrong-option";
  const row = dialog.rows[answer.chosen[0]!.index]!;
  // Selects, marks the tab, and advances, all on one press.
  return (await press(pane, String(row.number), runtime)) ? null : "pane-stalled";
}

/** A multi-select question: toggle to match, then leave by its own inline button. */
async function answerMany(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  opened: QuestionDialog,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const answer = answers[at]!;
  const wanted = new Set(answer.chosen.map((pick) => pick.index));
  let dialog = opened;
  const other = otherRowIndex(dialog);
  // Only where the pane disagrees. Somebody may have been ticking boxes at the keyboard, and a
  // blind press per wanted option would toggle theirs back off.
  for (let index = 0; index < other; index += 1) {
    const row = dialog.rows[index]!;
    if (row.ticked === wanted.has(index)) continue;
    if (!(await press(pane, String(row.number), runtime))) return "pane-stalled";
    const after = await reread(pane, answers, at, runtime);
    if (!after) return "wrong-dialog";
    dialog = after;
  }

  if (answer.other.length > 0) {
    if (!dialog.rows[other]!.ticked) {
      // The digit ticks this row without moving the cursor, which is the whole difference from the
      // single-select shape.
      if (!(await press(pane, String(dialog.rows[other]!.number), runtime))) return "pane-stalled";
    }
    const walked = await moveCursor(pane, answers, at, other, runtime);
    if (!walked) return "wrong-dialog";
    const typed = await typeOther(pane, answers, at, runtime);
    if (typed) return typed;
    // Tab is the measured way off the text row; it lands on the inline button.
    if (!(await press(pane, TAB, runtime))) return "pane-stalled";
  }

  const button = await moveCursorToButton(pane, answers, at, runtime);
  if (!button) return "wrong-dialog";
  return (await press(pane, RETURN, runtime)) ? null : "pane-stalled";
}

/**
 * Replaces what the free-text row holds with this question's text, cursor already on it.
 *
 * The clear is by backspace count rather than by a kill key, because no kill key was measured on
 * this row and a guessed one that means something else here would act on the dialog instead. A row
 * showing Claude's own prompt holds nothing, so it is not backspaced over at all: pressing
 * Backspace at an empty field is the one thing nobody has established is inert.
 */
async function typeOther(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  const dialog = await reread(pane, answers, at, runtime);
  if (!dialog) return "wrong-dialog";
  const row = dialog.rows[otherRowIndex(dialog)]!;
  const held = isPlaceholder(row.text) ? "" : row.text;
  if (held.length > 0 && !(await press(pane, RUBOUT.repeat(held.length), runtime))) {
    return "pane-stalled";
  }
  // Sanitised once and checked against the same string, because what the row ends up holding is
  // what was SENT. Checking against the original would fail every answer carrying an escape.
  const wanted = sanitised(answers[at]!.other);
  if (!(await press(pane, wanted, runtime))) return "pane-stalled";

  const after = await reread(pane, answers, at, runtime);
  if (!after) return "wrong-dialog";
  // The row wraps a long answer, so only its start is recoverable -- the same prefix check every
  // label gets. What this catches is a clear that under-counted, which shows up as the old text
  // still in front of the new.
  return saysTheSame(after.rows[otherRowIndex(after)]!.text, wanted) ? null : "wrong-option";
}

/**
 * An escape in somebody's typed answer must arrive as a character, not as a key.
 *
 * The same guard `paste` makes in the composer, and it matters more here: a bare escape on this
 * screen cancels the whole dialog and takes their words with it.
 */
function sanitised(text: string): string {
  return text.replaceAll("", "␛");
}

/**
 * Finishes the dialog, which for most calls means noticing it has already finished itself.
 *
 * A dialog of ONE single-select question draws no Submit tab at all and closes on the keystroke
 * that answers it -- measured, and it is the commonest shape there is. So an absent dialog here is
 * success rather than the `no-dialog` refusal it would be anywhere else in this module.
 */
async function submit(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  runtime: QuestionRuntime,
): Promise<TmuxQuestionRefusal | null> {
  if (questionDialog(await runtime.screen(pane)) === null) return null;
  const review = await goTo(pane, answers, "review", runtime);
  if (!review) return "wrong-dialog";
  // Never a partial submit. An unanswered tab here means a press did not land, and sending it
  // anyway would tell Claude the reader declined a question they answered.
  if (review.tabs.some((tab) => !tab.submit && !tab.answered)) return "wrong-dialog";
  const row = review.rows.find((entry) => entry.text === SUBMIT);
  if (!row?.number) return "wrong-dialog";

  await send(pane, String(row.number), runtime);
  // `poll` answers with the view that satisfied it, so a null here is the budget running out with
  // the dialog still on the screen.
  const gone = await poll(pane, runtime, (view) => questionDialog(view) === null);
  return gone === null ? "still-open" : null;
}

/**
 * Walks to a question by its TEXT, or to the review screen.
 *
 * Reading where it is after every step rather than counting from where it started, because a
 * person may have been navigating this dialog by hand and because the single-select digit advances
 * a tab by itself. That also means nothing here depends on which way the arrows clamp.
 */
async function goTo(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  target: number | "review",
  runtime: QuestionRuntime,
): Promise<QuestionDialog | null> {
  const wanted = target === "review" ? answers.length : target;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const dialog = questionDialog(await runtime.screen(pane));
    if (!dialog) return null;
    const at = locate(dialog, answers);
    if (at === null) return null;
    if (at === wanted) return dialog;
    // A cursor parked in the free-text row eats Left and Right as text-cursor moves, so it has to
    // come off that row before any tab step means anything. Only on a question screen: the review
    // screen's last row is `Cancel`, which is an ordinary row and not somewhere text goes.
    const typing = !dialog.review
      && dialog.rows.findIndex((row) => row.cursor) === otherRowIndex(dialog);
    if (!(await press(pane, typing ? TAB : at < wanted ? RIGHT : LEFT, runtime))) return null;
  }
  return null;
}

/** Which question the dialog is showing, as an index into `answers`, or the review screen. */
function locate(dialog: QuestionDialog, answers: readonly TmuxQuestionAnswer[]): number | null {
  if (dialog.review) return answers.length;
  if (!dialog.question) return null;
  const at = answers.findIndex((answer) => saysTheSame(dialog.question!, answer.question));
  return at < 0 ? null : at;
}

/** Walks the cursor onto one row, reading where it is between presses. */
async function moveCursor(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  wanted: number,
  runtime: QuestionRuntime,
): Promise<QuestionDialog | null> {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const dialog = await reread(pane, answers, at, runtime);
    if (!dialog) return null;
    const on = dialog.rows.findIndex((row) => row.cursor);
    if (on === wanted) return dialog;
    if (on < 0) return null;
    if (!(await press(pane, on < wanted ? DOWN : UP, runtime))) return null;
  }
  return null;
}

/** The same walk, onto whichever row is the inline button. */
async function moveCursorToButton(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  runtime: QuestionRuntime,
): Promise<QuestionDialog | null> {
  const dialog = await reread(pane, answers, at, runtime);
  if (!dialog) return null;
  const button = dialog.rows.findIndex((row) => row.button);
  return button < 0 ? null : await moveCursor(pane, answers, at, button, runtime);
}

/** The dialog as it is now, refusing if it has stopped showing the question being answered. */
async function reread(
  pane: string,
  answers: readonly TmuxQuestionAnswer[],
  at: number,
  runtime: QuestionRuntime,
): Promise<QuestionDialog | null> {
  const dialog = questionDialog(await runtime.screen(pane));
  if (!dialog || locate(dialog, answers) !== at) return null;
  return dialog;
}

/**
 * Sends keys and waits for the pane to look different.
 *
 * Waiting on DIFFERENCE rather than on a predicate about the result, which is the composer
 * module's lesson at another menu: the screen already satisfies most predicates before the redraw
 * lands, so a walk that waited for one would read a selection a press behind and step again.
 */
async function press(pane: string, keys: string, runtime: QuestionRuntime): Promise<boolean> {
  const before = (await runtime.screen(pane)).screen;
  await send(pane, keys, runtime);
  return (await poll(pane, runtime, (view) => view.screen !== before)) !== null;
}

function send(pane: string, keys: string, runtime: QuestionRuntime): Promise<void> {
  return runtime.send(pane, new TextEncoder().encode(keys));
}

/** Reads until the pane satisfies `wanted`, answering null when it never did. */
async function poll(
  pane: string,
  runtime: QuestionRuntime,
  wanted: (view: TmuxPaneView) => boolean,
): Promise<TmuxPaneView | null> {
  const limit = runtime.redrawLimitMs ?? REDRAW_LIMIT_MS;
  const wait = runtime.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = Date.now();
  for (;;) {
    const view = await runtime.screen(pane);
    if (wanted(view)) return view;
    if (Date.now() - started >= limit) return null;
    await wait(REDRAW_POLL_MS);
  }
}

/** A refusal, carrying back every word the reader typed so none of them is lost to it. */
function refused(
  reason: TmuxQuestionRefusal,
  answers: readonly TmuxQuestionAnswer[],
): TmuxQuestionOutcome {
  return {
    answered: false,
    reason,
    keptText: answers
      .filter((answer) => answer.other.length > 0)
      .map((answer) => ({ question: answer.question, text: answer.other })),
  };
}
