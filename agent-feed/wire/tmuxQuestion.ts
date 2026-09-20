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
