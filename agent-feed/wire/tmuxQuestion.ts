// Answering Claude's own AskUserQuestion dialog in a tmux pane, from the panel.
//
// The fourth way the panel reaches a session, and the one shaped least like the others. The
// composer mirror sends the text a box should be holding; this sends the ANSWERS a dialog should
// end up carrying, and the sidecar works out which keys produce them.
//
// Why the whole answer set travels in one request rather than a keystroke at a time:
//
// - **The reader's typed text must survive a refusal.** A person can type free text into any
//   question here, and in the pane that text is destroyed by Escape with no trace (measured
//   2026-09-11). If the panel drove this key by key, a refusal halfway would leave their words
//   nowhere. Sending them means the sidecar can hand them back in the outcome, and the panel
//   still holds its own copy the whole time.
// - **Half an answer is a wrong answer.** The dialog submits every question at once. A per-press
//   protocol has a state where two of four questions are answered and the connection dropped,
//   and nothing on either side owns finishing it.
// - **The pane is shared.** Somebody may be answering the same dialog at the keyboard. One
//   serialised operation that reads before each press can reconcile with them; a stream of
//   independent presses cannot.
//
// Claude-only, like the composer mirror, because the dialog this drives is the Claude TUI's.

/** Why a session's question dialog could not be answered. */
export type TmuxQuestionRefusal =
  /** No live process for this session is running inside a tmux pane. */
  | "no-pane"
  /** There is a pane, but tmux would not answer -- not installed, or its server is gone. */
  | "tmux-unavailable"
  /**
   * The pane answered and its screen holds no question dialog.
   *
   * The ordinary cause is that it has already been answered, in the pane or from another
   * surface, between the panel reading the transcript and this request arriving.
   */
  | "no-dialog"
  /**
   * The dialog on the pane is not the one these answers describe.
   *
   * A different number of questions, or a question whose text disagrees. Refused rather than
   * pressed through: the answers would land on questions nobody matched them to.
   */
  | "wrong-dialog"
  /** An option index names a row the dialog does not have, or its label disagrees. */
  | "wrong-option"
  /** The pane stopped redrawing partway through, so what landed cannot be established. */
  | "pane-stalled"
  /** The dialog was still open after submitting, so the answers cannot be claimed as sent. */
  | "still-open";

/**
 * The dialog as the pane is drawing it at this moment, for a panel that follows along.
 *
 * The other direction from everything else in this file. `TmuxQuestionAnswer` says what a dialog
 * should END UP holding; this says what it holds NOW, so a reader answering in the panel sees what
 * somebody at the keyboard has already done rather than a blank draft that will overwrite it.
 *
 * What a panel matches and follows by is the STATE -- which rows are marked, which question the
 * terminal is on, what the free-text row holds. The tool call is the content, untruncated, and
 * wins wherever the panel has it.
 *
 * The screen's own copy of the content rides along too (`prompt`, each option's `detail`), for the
 * one case where the panel has no tool call to draw from: the CLI writes the asking turn to the
 * transcript only once it is answered, and the live mirror that runs ahead of the file loses a turn
 * whenever proxy-agent's capture drops mid-response (measured 2026-10-14: the capture died 15s into
 * a turn and the question stood in the pane with nothing anywhere else saying so). Then the screen
 * is the only witness, and a worse copy beats a dialog the panel cannot see.
 */
export interface TmuxQuestionState {
  /**
   * The first line of the question on screen, or null on the review screen.
   *
   * What everything matches against, by prefix. Only its first line because a question wraps, and
   * the first line is the one part of it whose start is certain.
   */
  question: string | null;
  /**
   * The whole question as drawn, its wrapped lines joined with single spaces, or null on the review
   * screen.
   */
  prompt: string | null;
  review: boolean;
  /** Whether the rows carry checkboxes, which is the same fact the tool call states. */
  multiSelect: boolean;
  /** One entry per question of the call, in the tab row's own order. */
  tabs: { label: string; answered: boolean }[];
  /**
   * The option rows, in order, without the free-text row that follows them.
   *
   * `label` is what the SCREEN says, which is not always the whole label: a long one wraps onto a
   * row indented exactly like a description, so only its start is recoverable. Match it against
   * the tool call's own options by prefix, the way the driver does before it presses anything.
   */
  options: {
    label: string;
    /**
     * Every line drawn under the label until the next row, joined with single spaces.
     *
     * The description, and the tail of a label that wrapped, which the screen indents the same way
     * and so cannot be told apart. Empty when nothing is drawn there.
     */
    detail: string;
    marked: boolean;
    cursor: boolean;
  }[];
  /** What the free-text row holds, or null while it is still showing its own prompt. */
  other: string | null;
}

/** What one question should end up answered with. */
export interface TmuxQuestionAnswer {
  /**
   * The question's own text, checked against the pane before anything is pressed.
   *
   * The counting rule this repository already uses for the rewind picker: position picks the row
   * and text decides whether to go through with it. A tab index alone would answer whatever
   * question happens to be sitting there.
   */
  question: string;
  /**
   * The options to choose, by their index in the tool call's own `options` array, each with the
   * label that index is expected to name.
   *
   * A list even for a single-select question, where it holds at most one. The dialog's own shape
   * decides how they are pressed, and the sidecar reads that shape rather than being told it.
   */
  chosen: { index: number; label: string }[];
  /**
   * Free text for this question's own "Type something" row, or "" for none.
   *
   * Carried per question rather than once per dialog because the dialog offers one per question.
   */
  other: string;
}

export type TmuxQuestionOutcome =
  | { answered: true }
  | {
      answered: false;
      reason: TmuxQuestionRefusal;
      /**
       * Every non-empty `other` that was sent, returned verbatim beside the question it was for.
       *
       * The point of the whole shape. A refusal that dropped a person's typed words would be the
       * failure this protocol exists to prevent, so the words come back with the reason and the
       * caller puts them back in the field they were written in. Paired with its question rather
       * than sent as a bare list, because a list of sentences with no idea which box each came out
       * of is not something a surface can put back.
       */
      keptText: { question: string; text: string }[];
      /**
       * Whether any key reached the pane before this refused.
       *
       * A refusal is not always a no-op, and saying it was is the failure this field exists to stop.
       * The driver walks the dialog pressing as it goes, so a question that moves under it can refuse
       * with one question already answered and a box already ticked in the terminal -- measured, and
       * the panel said "nothing was sent" over the top of it. False means no key went out at all,
       * which is the ordinary case: most refusals are decided before the first press.
       */
      sent: boolean;
    };

/**
 * Where the pane's cursor should be sitting, which is not an answer to anything.
 *
 * The live half of the mirror, and the reason it is a separate shape from `TmuxQuestionAnswer`
 * rather than a flag on it: an answer is a commitment that cannot be taken back, and this is a
 * highlight moving. A reader scrolling the options in the panel is deciding, not deciding-and-
 * submitting, so what crosses here must be incapable of finishing the dialog.
 *
 * That is a constraint on the KEYS the sidecar may press, and it is why this exists at all. A
 * digit on a single-select question selects the row, marks the tab answered and advances to the
 * next question in one press -- so the obvious way to put the cursor on option two is the one way
 * that also answers the question. Only the arrows move without committing, which is what the
 * driver behind this is restricted to.
 *
 * `questions` carries the whole call rather than just the one being pointed at, because the
 * dialog is located by question TEXT rather than by counting tabs -- the same rule the answers
 * use, and what makes this work when somebody has been navigating the dialog by hand.
 */
export interface TmuxQuestionPoint {
  /** Every question of the call, in the tool call's own order. */
  questions: string[];
  /** Which of them to point at, as an index into `questions`. */
  at: number;
  /** The option to put the cursor on, by its index in that question's own `options`. */
  option: number;
  /** The label that index is expected to name, checked against the row before anything moves. */
  label: string;
}

/**
 * Whether the cursor was moved.
 *
 * Carries no `keptText` and no `sent`, unlike an answer's outcome, because there is nothing to
 * lose here: nothing was typed, and a refusal leaves a cursor wherever it already was. A caller
 * that gets `false` has a mirror one step behind, not a reader's words missing.
 */
export type TmuxQuestionPointOutcome = { pointed: true } | { pointed: false; reason: TmuxQuestionRefusal };
