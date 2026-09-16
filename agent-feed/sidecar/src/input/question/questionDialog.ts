/**
 * Reading Claude's own AskUserQuestion dialog off a tmux pane.
 *
 * The reader half. `questionAnswer.ts` is what presses keys at it, and everything below is a
 * measured property of Claude Code 2.1.268 taken by hand on 2026-09-11, with the screens it was
 * taken from kept verbatim in `questionCaptures.ts`.
 *
 * The dialog replaces the composer box entirely for as long as it is up -- no prompt row, no
 * status line, no session-title rule -- which is why `tmuxComposer` reports `no-composer` the
 * whole time and why nothing here can be found by looking near the box.
 *
 * Its shape between two rules is fixed, and that is what this parses on:
 *
 *   <rule>
 *   <tab row>            one entry per question, then a Submit entry when the dialog draws one
 *   <blank>
 *   <question text>
 *   <blank>
 *   <numbered rows, each optionally followed by wrapped label and description lines>
 *   [<inline button row>]   `Submit` or `Next`, multi-select only
 *   <rule>
 *   <`Chat about this` row>
 *   <blank>
 *   <footer>             contains `Esc to cancel`, possibly wrapped across two rows
 *
 * What varies inside it, and why each one is here rather than assumed away:
 *
 *   **The tab row is always drawn, and its arrows and Submit entry are not.** One single-select
 *   question renders ` ☐ Colour` alone: nothing to navigate between, and an answer that needs no
 *   confirming. Anything else renders `←  ☐ A  ☒ B  ✔ Submit  →`. `☐` is unanswered and `☒` is
 *   answered, so the tab row is where this reads which questions still need one.
 *
 *   **WHICH tab is active is drawn in colour only** -- black on `48;5;153`, no glyph, no marker.
 *   So it is deliberately not reported here, and the driver finds its place by matching the
 *   QUESTION TEXT instead. That is the better question anyway: an index says where the cursor
 *   happens to be, and the text says whether it is the question the answers were written for.
 *
 *   **Indentation means nothing.** A single-select question indents its descriptions by five
 *   spaces and a multi-select one by two, measured in the same session minutes apart. Rows are
 *   found by their `N. ` prefix and everything else between them is continuation.
 *
 *   **A long label WRAPS rather than truncating**, onto a row indented exactly like a description,
 *   so a wrapped label cannot be told from a description and the full text cannot be recovered
 *   from the screen. Every text check here is therefore a PREFIX check, which is the same rule
 *   `rewindPicker` arrived at for the same reason -- and `saysTheSame` is imported from there
 *   rather than written again.
 *
 *   **A single-select answer is a TRAILING tick, not the cursor.** Revisiting an answered question
 *   draws `  2. BBB ✔` and puts the cursor back on row one. Reading the cursor as the answer would
 *   be wrong on every question a person has already been through.
 *
 *   **A multi-select row carries its own box**, `[ ]` or `[✔]`, and the free-text row carries one
 *   too -- ticked independently of whether it holds any text.
 *
 *   **The review screen has no footer and no closing rule**, so the anchor every other shape is
 *   found by is absent there. It is found by its own `Ready to submit your answers?` line.
 *
 *   **The footer WRAPS, and the anchor goes with it.** Once the cursor reaches a free-text row
 *   Claude adds `ctrl+g to edit in VS Code` to it, taking the line to 84 characters, so on an
 *   80-column pane `Esc to cancel` lands split across two rows and no single line holds it. It is
 *   therefore read as the run it belongs to rather than row by row; see `footerStart`.
 *
 *   **A question whose options carry PREVIEWS is drawn in two columns, and that changes what a
 *   row is.** Measured 2026-09-16 on 2.1.273. A SINGLE-SELECT question with at least one option
 *   preview draws its labels in a narrow left band with the preview panel beside them, so every
 *   option row also holds a slice of that panel -- and a label check against it fails, which is
 *   the whole of why answering one refused with `wrong-option` and sent nothing. It is a property
 *   of the QUESTION rather than of the call: a no-preview question in the same dialog draws one
 *   column, and a multi-select question draws one even when its options carry previews. Two more
 *   things ride with it. An answered row's tick sits inside the band rather than at the end of the
 *   line. And there is NO numbered free-text row at all: its free text is the `Notes` field under
 *   the panel, reached with `n` rather than with a digit, so `otherRowIndex` answers -1 for this
 *   shape and the driver takes another route entirely.
 *
 * The free-text row is always the LAST numbered row inside the box, after every option. Nothing
 * here asserts that on its own: the driver knows how many options the tool call carried and
 * refuses a dialog whose row count disagrees, so the assumption is checked on every use instead of
 * being trusted once here.
 */
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";
import { plainText } from "@/input/composerBox";

/** What the free-text row says before anybody types in it, in each of the two shapes. */
export const PLACEHOLDERS = ["Type something.", "Type something"] as const;

/** The line that identifies the review screen, which has no other anchor. */
const READY = "Ready to submit your answers?";
/** The glyph Claude puts on the row the cursor is on. */
const MARKER = "❯";
/** How much box drawing makes a line one of the dialog's rules. */
const RULE = /^─{8}/;
/** One numbered row: the marker or a space, then the number Claude drew, which is its hotkey. */
const ROW = /^(❯| ) (\d+)\. (.*)$/;
/** A multi-select row's own checkbox, which sits between the number and the label. */
const BOX = /^\[([ ✔])\]\s*(.*)$/;
/** The inline button under a multi-select question's rows. It carries no number. */
const BUTTON = /^(❯| ) {4}(Submit|Next)\s*$/;
/** What every question screen's footer says, and the only thing that identifies one. */
const FOOTER = "Esc to cancel";
/** The label of the free-text field a two-column question draws under its preview panel. */
const NOTES = "Notes:";
/** What the preview panel's own border draws, in the column the left band ends at. */
const PANEL = /^[\u250c\u2502\u251c\u2514]/;
/** In the footer only while a text field holds the keyboard, which is how focus is read here. */
const EDITOR = "ctrl+g to edit in VS Code";
/** One tab: its state glyph and its label, up to the next glyph or the closing arrow. */
const TAB = /([☐☒✔])\s+([^☐☒✔→]+)/g;

/** One row inside the dialog's box. */
export interface QuestionRow {
  /** The digit that selects this row, or null for the inline button, which has none. */
  number: number | null;
  /** What the row says. A wrapped label arrives here truncated, so only its start is reliable. */
  text: string;
  /** Whether the cursor is on this row, which is where typing and Space land. */
  cursor: boolean;
  /** A multi-select row's tick, or null on a row that draws no box. */
  ticked: boolean | null;
  /** A single-select row's trailing tick, which is how an answered question shows its answer. */
  chosen: boolean;
  /** The inline `Submit`/`Next` button rather than an answer row. */
  button: boolean;
}

/** One entry of the tab row. */
export interface QuestionTab {
  label: string;
  /** Drawn `☒` rather than `☐`. Always false for the Submit entry, which draws `✔`. */
  answered: boolean;
  submit: boolean;
}

/**
 * The free-text field a two-column question draws, which is not one of its rows.
 *
 * Its own thing rather than a row because nothing reaches it by number: `n` opens it, and a digit
 * pressed while it is closed moves the cursor among the options instead.
 */
export interface QuestionNotes {
  /** What it holds, verbatim. It may be Claude's own prompt; `isPlaceholder` tells them apart. */
  text: string;
  /** Whether it holds the keyboard, in which case `n` would be typed into it rather than open it. */
  focused: boolean;
}

/** A question dialog as the pane is drawing it right now. */
export interface QuestionDialog {
  tabs: QuestionTab[];
  /** The question being shown, or null on the review screen. */
  question: string | null;
  review: boolean;
  /** Whether this question's rows carry checkboxes, which changes what every key does. */
  multiSelect: boolean;
  /** The rows inside the box. `Chat about this` is outside it and is not one of these. */
  rows: QuestionRow[];
  /** The two-column shape's `Notes` field, or null on a question drawn in one column. */
  notes: QuestionNotes | null;
}

/**
 * The question dialog on this screen, or null when there is not one.
 *
 * Null is also the answer for a pane caught mid-redraw, and this does not try to tell those apart
 * for the reason the composer module measured: tmux cannot, because a repaint erases the whole
 * screen inside one cursor-hide bracket. The driver polls rather than guessing.
 */
export function questionDialog(view: TmuxPaneView): QuestionDialog | null {
  const lines = view.screen.split("\n").map(plainText);
  const ready = lastIndex(lines, (line) => line.trim() === READY);
  if (ready >= 0) return reviewScreen(lines, ready);
  return questionScreen(lines);
}

/** The review screen, found by its own prose because it draws no footer and no closing rule. */
function reviewScreen(lines: readonly string[], ready: number): QuestionDialog | null {
  const rows: QuestionRow[] = [];
  for (let index = ready + 1; index < lines.length; index += 1) {
    const row = numberedRow(lines[index]!);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  const opening = lastIndex(lines.slice(0, ready), (line) => RULE.test(line));
  return {
    tabs: opening >= 0 ? tabRow(lines[opening + 1] ?? "") : [],
    question: null,
    review: true,
    multiSelect: false,
    rows,
    notes: null,
  };
}

/** A question's own screen, found by the footer and bounded by the two rules above it. */
function questionScreen(lines: readonly string[]): QuestionDialog | null {
  const footer = footerStart(lines);
  if (footer < 0) return null;
  const closing = lastIndex(lines.slice(0, footer), (line) => RULE.test(line));
  if (closing < 0) return null;
  const opening = lastIndex(lines.slice(0, closing), (line) => RULE.test(line));
  if (opening < 0) return null;

  const tabs = tabRow(lines[opening + 1] ?? "");
  if (tabs.length === 0) return null;
  const inside = lines.slice(opening + 2, closing);
  // Cut to the left band before anything is read out of it, so a two-column question's rows are
  // its labels rather than its labels with a slice of the preview panel stuck to them.
  const band = notesField(inside, lines.slice(closing));
  const box = band ? inside.map((line) => line.slice(0, band.column).trimEnd()) : inside;
  // The first non-blank line after the tab row. Reading it by offset instead would break on the
  // day Claude puts anything else between them, and this costs one scan.
  //
  // Read UNCUT, unlike the rows: the panel starts beside the first option and leaves this line the
  // whole width, so cutting it to the band would truncate any question longer than the band is
  // wide -- which is most of them. Caught by a capture whose question is three characters too
  // long, having been invisible on one whose question was short enough to survive.
  const asked = inside.find((line) => line.trim().length > 0);
  if (!asked) return null;

  const rows: QuestionRow[] = [];
  for (const line of box) {
    const row = numberedRow(line) ?? buttonRow(line);
    // A line this cannot parse is a wrapped label or a description, and is skipped rather than
    // counted. Neither carries anything the driver acts on.
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  return {
    tabs,
    question: asked.trim(),
    review: false,
    multiSelect: rows.some((row) => row.ticked !== null),
    rows,
    notes: band ? { text: band.text, focused: band.focused } : null,
  };
}

/**
 * The `Notes` field of a two-column question, with the column its left band ends at.
 *
 * `below` is everything under the closing rule rather than the footer alone, because `footerStart`
 * answers with the row that COMPLETES the anchor -- which on a wrapped footer is its last row, and
 * the `ctrl+g` hint that says a field has the keyboard sits above it.
 *
 * TWO things have to agree before a screen is read as that layout, because cutting every line at a
 * column is not something to do on a guess: a `Notes:` label indented into the middle of the
 * screen, and the preview panel's own border drawn in that same column. A one-column question has
 * neither, and nothing else on these screens has both.
 */
function notesField(
  box: readonly string[],
  below: readonly string[],
): { column: number; text: string; focused: boolean } | null {
  const line = box.find((entry) => entry.startsWith(" ") && entry.trimStart().startsWith(NOTES));
  if (!line) return null;
  const column = line.indexOf(NOTES);
  if (column <= 0 || !box.some((entry) => PANEL.test(entry.slice(column)))) return null;
  return {
    column,
    text: line.slice(column + NOTES.length).trim(),
    // The same hint the one-column shape puts in its footer when the cursor reaches a text row.
    focused: below.some((entry) => entry.includes(EDITOR)),
  };
}

/** The tab row's entries, or none when this line is not one. */
function tabRow(line: string): QuestionTab[] {
  const tabs: QuestionTab[] = [];
  TAB.lastIndex = 0;
  for (let match = TAB.exec(line); match !== null; match = TAB.exec(line)) {
    const label = match[2]!.trim();
    if (!label) continue;
    tabs.push({ label, answered: match[1] === "☒", submit: match[1] === "✔" });
  }
  return tabs;
}

function numberedRow(line: string): QuestionRow | null {
  const match = ROW.exec(line);
  if (!match) return null;
  const cursor = match[1] === MARKER;
  const box = BOX.exec(match[3]!);
  if (box) {
    return {
      number: Number(match[2]),
      text: box[2]!.trim(),
      cursor,
      ticked: box[1] === "✔",
      chosen: false,
      button: false,
    };
  }
  // The trailing tick a single-select question puts on the row it has been answered with. Taken
  // off the text so a label check compares like with like.
  const answered = /\s✔$/.test(match[3]!);
  return {
    number: Number(match[2]),
    text: (answered ? match[3]!.replace(/\s✔$/, "") : match[3]!).trim(),
    cursor,
    ticked: null,
    chosen: answered,
    button: false,
  };
}

function buttonRow(line: string): QuestionRow | null {
  const match = BUTTON.exec(line);
  if (!match) return null;
  return {
    number: null,
    text: match[2]!,
    cursor: match[1] === MARKER,
    ticked: null,
    chosen: false,
    button: true,
  };
}

/**
 * Which row is the free-text one, or -1 when the dialog draws none.
 *
 * Always the last numbered row in the box: the tool's own options are drawn first and this follows
 * them, with the inline button and `Chat about this` outside the numbered run this reads. -1 is
 * also the answer for a two-column question, which draws no free-text row at all.
 */
export function otherRowIndex(dialog: QuestionDialog): number {
  // A two-column question has none: nothing on it is reached by number except its options, and its
  // free text is the `Notes` field, which is not a row.
  if (dialog.notes) return -1;
  for (let index = dialog.rows.length - 1; index >= 0; index -= 1) {
    if (!dialog.rows[index]!.button) return index;
  }
  return -1;
}

/** Whether a free-text field is showing Claude's own prompt rather than somebody's words. */
export function isPlaceholder(text: string): boolean {
  const said = text.trim();
  return (PLACEHOLDERS as readonly string[]).includes(said) || isNotePrompt(said);
}

/**
 * The two spellings a `Notes` field's own prompt takes, measured on 2.1.273.
 *
 * `press n to add notes` while it is idle, and `Add notes on this design...` once it has the
 * keyboard. The second one says `design` whatever the question is about -- measured on a question
 * about fruit -- so it reads as a fixed sentence, and is matched loosely anyway because nothing
 * here depends on which of the two it is beyond knowing that nobody typed it.
 */
function isNotePrompt(said: string): boolean {
  return said === "press n to add notes" || /^Add notes on .+\u2026$/.test(said);
}

/**
 * Where the footer begins, or -1 when this screen has none.
 *
 * The footer is ONE logical line the pane may have broken across rows, so it is read as the run of
 * non-blank lines it belongs to rather than row by row. Measured 2026-09-15 on an 80x24 pane: with
 * the cursor on a free-text row the footer runs to 84 characters and `Esc to cancel` is split in
 * two, so nothing on the screen contains it. The reader then answered null for a dialog plainly on
 * the pane, and the driver read that as the question having moved on -- refusing after it had
 * already ticked a box, while the panel reported that nothing had been sent. Every capture was
 * taken at 120 columns, which is why the whole suite agreed with the parser.
 *
 * The run resets at a blank line and at a rule, neither of which a footer ever spans.
 */
function footerStart(lines: readonly string[]): number {
  let run = "";
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.trim().length === 0 || RULE.test(line)) {
      run = "";
      start = -1;
      continue;
    }
    run = run ? `${line.trim()} ${run}` : line.trim();
    start = index;
    if (run.includes(FOOTER)) return start;
  }
  return -1;
}

function lastIndex(lines: readonly string[], wanted: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (wanted(lines[index]!)) return index;
  }
  return -1;
}
