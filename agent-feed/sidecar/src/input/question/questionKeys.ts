/**
 * The keyboard half of driving a question dialog: what to press, and how to know it landed.
 *
 * Split out of `questionAnswer.ts` when a second dialog SHAPE arrived. A single-select question
 * whose options carry previews is drawn in two columns and answered with different keys entirely,
 * so there are two answerers now -- `questionAnswer.ts` for the shape with numbered rows and a
 * free-text row, `questionPreview.ts` for the two-column one. What they share is everything about
 * MOVING between questions: the same tabs to walk, the same redraws to wait for, the same silence
 * to refuse on. Keeping that here is what let the second shape be a second answerer rather than a
 * second copy of the first.
 */
import { bytesForRailKey } from "@agentdesk/agent-feed-wire";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";
import { saysTheSame } from "@/input/rewindPicker";
import { otherRowIndex, questionDialog, type QuestionDialog } from "@/input/question/questionDialog";

/**
 * All these walks need of a call: the text of each question, in the dialog's own order.
 *
 * Narrower than `TmuxQuestionAnswer` on purpose. Walking to a question and putting the cursor on a
 * row are the same journey whether or not there is an answer to press at the end of it, and the
 * live cursor mirror has no answers at all -- only a reader looking at an option. Typing the walk
 * to the answer shape would have forced that caller to invent empty answers to satisfy it, which
 * is a lie about intent in exactly the module whose whole job is not pressing the wrong key.
 *
 * `TmuxQuestionAnswer` satisfies this structurally, so every existing caller passes as it is.
 */
export interface QuestionAsked {
  question: string;
}

export const UP = bytesForRailKey("up");
export const DOWN = bytesForRailKey("down");
export const LEFT = bytesForRailKey("left");
export const RIGHT = bytesForRailKey("right");
export const TAB = bytesForRailKey("tab");
export const RETURN = "\r";
/** What a terminal sends for Backspace, which is DEL rather than BS. */
export const RUBOUT = "";
/**
 * Puts a text cursor at the end of what a field already holds.
 *
 * Needed only by the `Notes` field, which opens with the cursor at the START of any text it is
 * already holding -- measured 2026-09-16, by typing one character and watching it land in front of
 * the rest. Backspacing from there deletes nothing at all, so a replacement that skipped this
 * would prepend to somebody's note rather than replace it.
 */
export const END_OF_LINE = "";

export const REDRAW_LIMIT_MS = 4_000;
export const REDRAW_POLL_MS = 25;
/**
 * How many reads any one walk may take.
 *
 * A bound on how long this may hold a pane, not on how far a cursor may travel: the tool caps a
 * call at four questions of four options, so every real walk here is a handful of steps and this
 * only stops a pane that has stopped moving from spinning the budget.
 */
export const MAX_STEPS = 24;

/** Everything the answerers need from tmux, injected so the suite needs no tmux server. */
export interface QuestionRuntime {
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<TmuxPaneView>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
  /** Overridable so a test does not spend the live redraw budget proving a refusal. */
  redrawLimitMs?: number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Walks to a question by its TEXT, or to the review screen.
 *
 * Reading where it is after every step rather than counting from where it started, because a
 * person may have been navigating this dialog by hand and because the single-select digit advances
 * a tab by itself. That also means nothing here depends on which way the arrows clamp.
 */
export async function goTo(
  pane: string,
  answers: readonly QuestionAsked[],
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
    // A two-column question whose `Notes` field has the keyboard eats every key as text -- Tab and
    // both side arrows, measured -- so stepping from here would write into somebody's half-typed
    // note instead of moving. The one measured way out of that field commits it as their answer,
    // which is not this module's to do on their behalf, so this gives up with the pane untouched.
    if (dialog.notes?.focused) return null;
    // A cursor parked in the free-text row eats Left and Right as text-cursor moves, so it has to
    // come off that row before any tab step means anything. Only on a question screen: the review
    // screen's last row is `Cancel`, which is an ordinary row and not somewhere text goes.
    const typing = !dialog.review && dialog.rows.findIndex((row) => row.cursor) === otherRowIndex(dialog);
    if (!(await press(pane, typing ? TAB : at < wanted ? RIGHT : LEFT, runtime))) return null;
  }
  return null;
}

/** Which question the dialog is showing, as an index into `answers`, or the review screen. */
export function locate(dialog: QuestionDialog, answers: readonly QuestionAsked[]): number | null {
  if (dialog.review) return answers.length;
  if (!dialog.question) return null;
  const at = answers.findIndex((answer) => saysTheSame(dialog.question!, answer.question));
  return at < 0 ? null : at;
}

/** Walks the cursor onto one row, reading where it is between presses. */
export async function moveCursor(
  pane: string,
  answers: readonly QuestionAsked[],
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
export async function moveCursorToButton(
  pane: string,
  answers: readonly QuestionAsked[],
  at: number,
  runtime: QuestionRuntime,
): Promise<QuestionDialog | null> {
  const dialog = await reread(pane, answers, at, runtime);
  if (!dialog) return null;
  const button = dialog.rows.findIndex((row) => row.button);
  return button < 0 ? null : await moveCursor(pane, answers, at, button, runtime);
}

/** The dialog as it is now, refusing if it has stopped showing the question being answered. */
export async function reread(
  pane: string,
  answers: readonly QuestionAsked[],
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
export async function press(pane: string, keys: string, runtime: QuestionRuntime): Promise<boolean> {
  const before = (await runtime.screen(pane)).screen;
  await send(pane, keys, runtime);
  return (await poll(pane, runtime, (view) => view.screen !== before)) !== null;
}

export function send(pane: string, keys: string, runtime: QuestionRuntime): Promise<void> {
  return runtime.send(pane, new TextEncoder().encode(keys));
}

/** Reads until the pane satisfies `wanted`, answering null when it never did. */
export async function poll(
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

/**
 * Whether the dialog has gone, as opposed to the screen being unreadable.
 *
 * Two reads rather than one, and that is the whole point. This module reads a dialog off a screen,
 * so "not a dialog" is also what a pane caught mid-redraw says, and what an unfamiliar shape says
 * -- and the caller treats this answer as SUCCESS. A screen that is merely between paints changes
 * between two reads a poll interval apart; one with no dialog on it does not. So the second read
 * has to agree, character for character, before anything is reported as answered.
 */
export async function dialogGone(pane: string, runtime: QuestionRuntime): Promise<boolean> {
  const first = await runtime.screen(pane);
  if (questionDialog(first) !== null) return false;
  await waiter(runtime)(REDRAW_POLL_MS);
  const second = await runtime.screen(pane);
  return second.screen === first.screen && questionDialog(second) === null;
}

/** The same question, asked until the redraw budget runs out. */
export async function waitForDialogToGo(pane: string, runtime: QuestionRuntime): Promise<boolean> {
  const limit = runtime.redrawLimitMs ?? REDRAW_LIMIT_MS;
  const started = Date.now();
  for (;;) {
    if (await dialogGone(pane, runtime)) return true;
    if (Date.now() - started >= limit) return false;
    await waiter(runtime)(REDRAW_POLL_MS);
  }
}

export function waiter(runtime: QuestionRuntime): (ms: number) => Promise<void> {
  return runtime.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
}

/**
 * An escape in somebody's typed answer must arrive as a character, not as a key.
 *
 * The same guard `paste` makes in the composer, and it matters more here: a bare escape on this
 * screen cancels the whole dialog and takes their words with it.
 */
export function sanitised(text: string): string {
  return text.replaceAll("", "␛");
}
