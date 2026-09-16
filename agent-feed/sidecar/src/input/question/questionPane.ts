/**
 * A pane that behaves like Claude's question dialog, for the driver's tests.
 *
 * A stand-in rather than a mock: it draws the screens `questionCaptures.ts` recorded and it acts on
 * keys the way the real dialog was measured to, so a driver tested against it is tested against the
 * measurements rather than against its own assumptions. The captures suite is what keeps the
 * drawing honest, and every rule in `key` below is one line of the header of `questionAnswer.ts`.
 *
 * Not test-only by accident of where it sits: it is a description of an external program's
 * behaviour, which is the sort of thing that should be readable next to the code that drives it.
 */

/** One question, as the tool call describes it. */
export interface PaneQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: string[];
  /**
   * Whether its options carry previews, which is what makes Claude draw it in two columns.
   *
   * Only a single-select question changes shape for it: a multi-select one with previews draws the
   * ordinary one column, measured, so this is ignored there the way the renderer ignores it.
   */
  preview?: boolean;
}

const PLACEHOLDER = { single: "Type something.", multi: "Type something" };
/** What the `Notes` field says before anybody opens it, and once it has the keyboard. */
const NOTE_PROMPT = { idle: "press n to add notes", open: "Add notes on this design\u2026" };
/** How wide the left band is before the preview panel starts. Measured at 80 and at 120 columns. */
const BAND = 34;
/** The two keys the `Notes` field needs, neither of which any rail key names. */
const END_OF_LINE = String.fromCharCode(5);
const DELETE = String.fromCharCode(0x7f);
const RULE = "────────────────────────────────────────────────────────────";

export class QuestionPane {
  /** Which tab is showing. `questions.length` is the review screen. */
  tab = 0;
  /** Which row the cursor is on, within the showing question. */
  cursor = 0;
  /** The single-select answer per question, as an option index or -1 for the free-text row. */
  chosen: number[];
  /** The multi-select ticks per question, option indices. */
  ticked: Set<number>[];
  /** Whether the free-text row's own box is ticked, which multi-select draws. */
  otherTicked: boolean[];
  /** What is typed into each question's free-text row. */
  other: string[];
  /** What is typed into each two-column question's `Notes` field. */
  notes: string[];
  /** Whether a committed note stands as this question's answer. */
  noteGiven: boolean[];
  /**
   * Where the caret sits in the `Notes` field, or null while that field has not got the keyboard.
   *
   * Modelled rather than assumed away because the driver depends on it: the field opens with its
   * caret at the START of what it already holds, so a backspace there deletes nothing and a
   * replacement written without `END_OF_LINE` first would prepend to somebody's note.
   */
  noteCaret: number | null = null;
  answered: boolean[];
  /** Set when the dialog submits or cancels, after which the pane draws an ordinary composer. */
  closed: "submitted" | "cancelled" | null = null;

  constructor(readonly questions: PaneQuestion[]) {
    this.chosen = questions.map(() => -2);
    this.ticked = questions.map(() => new Set<number>());
    this.otherTicked = questions.map(() => false);
    this.other = questions.map(() => "");
    this.notes = questions.map(() => "");
    this.noteGiven = questions.map(() => false);
    this.answered = questions.map(() => false);
  }

  /** Whether this dialog draws a Submit tab: anything but a lone single-select question. */
  get hasSubmitTab(): boolean {
    return this.questions.length > 1 || this.questions[0]!.multiSelect;
  }

  /** How many rows the showing question has, the inline button included. */
  private rowCount(at: number): number {
    return this.questions[at]!.options.length + 1 + (this.questions[at]!.multiSelect ? 1 : 0);
  }

  private otherRow(at: number): number {
    return this.questions[at]!.options.length;
  }

  screen(): string {
    if (this.closed) return `${RULE}\n❯ \n${RULE}\n  a session  Haiku 4.5`;
    return this.tab >= this.questions.length ? this.review() : this.question(this.tab);
  }

  private tabRow(): string {
    const entries = this.questions.map((question, at) =>
      `${this.answered[at] ? "☒" : "☐"} ${question.header}`
    );
    if (!this.hasSubmitTab) return ` ${entries[0]}`;
    return `←  ${[...entries, "✔ Submit"].join("  ")}  →`;
  }

  /** Whether this question is drawn in two columns, which only a single-select one ever is. */
  private twoColumn(at: number): boolean {
    const question = this.questions[at]!;
    return question.preview === true && !question.multiSelect;
  }

  /**
   * A two-column question: the labels in a narrow band, the preview panel and `Notes` beside them.
   *
   * Drawn rather than described, because the drawing is what broke the reader -- every option row
   * also carries a slice of the panel, so a label check against the raw row fails.
   */
  private previewQuestion(at: number): string {
    const question = this.questions[at]!;
    const band = question.options.map((label, index) => {
      const mark = this.cursor === index ? "\u276f " : "  ";
      const row = `${mark}${index + 1}. ${label}`;
      return (this.chosen[at] === index ? `${row.padEnd(BAND - 5)}\u2714` : row).padEnd(BAND);
    });
    const panel = [
      `\u250c${"\u2500".repeat(42)}\u2510`,
      `\u2502 a preview${" ".repeat(32)}\u2502`,
      `\u2514${"\u2500".repeat(42)}\u2518`,
    ];
    const held = this.notes[at]!
      || (this.noteCaret === null ? NOTE_PROMPT.idle : NOTE_PROMPT.open);
    const rows: string[] = [];
    for (let line = 0; line < Math.max(band.length, panel.length); line += 1) {
      rows.push(`${band[line] ?? " ".repeat(BAND)}${panel[line] ?? ""}`.trimEnd());
    }
    const tabs = this.questions.length > 1 ? " \u00b7 Tab to switch questions" : "";
    const editing = this.noteCaret === null ? "" : " \u00b7 ctrl+g to edit in VS Code";
    return [
      RULE,
      this.tabRow(),
      "",
      question.question,
      "",
      ...rows,
      "",
      `${" ".repeat(BAND)}Notes: ${held}`,
      "",
      RULE,
      "  Chat about this",
      "",
      `Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes${tabs}${editing} \u00b7 Esc to cancel`,
    ].join("\n");
  }

  private question(at: number): string {
    if (this.twoColumn(at)) return this.previewQuestion(at);
    const question = this.questions[at]!;
    const lines = [RULE, this.tabRow(), "", question.question, ""];
    const mark = (row: number) => (this.cursor === row ? "❯ " : "  ");
    question.options.forEach((label, index) => {
      const box = question.multiSelect ? (this.ticked[at]!.has(index) ? "[✔] " : "[ ] ") : "";
      const tick = !question.multiSelect && this.chosen[at] === index ? " ✔" : "";
      lines.push(`${mark(index)}${index + 1}. ${box}${label}${tick}`);
      lines.push(`     A description of ${label}.`);
    });
    const other = this.otherRow(at);
    const box = question.multiSelect ? (this.otherTicked[at] ? "[✔] " : "[ ] ") : "";
    const held = this.other[at] ||
      (question.multiSelect ? PLACEHOLDER.multi : PLACEHOLDER.single);
    const tick = !question.multiSelect && this.chosen[at] === -1 ? " ✔" : "";
    lines.push(`${mark(other)}${other + 1}. ${box}${held}${tick}`);
    if (question.multiSelect) {
      lines.push(`${this.cursor === other + 1 ? "❯" : " "}    ${at === this.questions.length - 1 ? "Submit" : "Next"}`);
    }
    lines.push(RULE, `  ${this.rowCount(at) + 1}. Chat about this`, "");
    lines.push("Enter to select · Tab/Arrow keys to navigate · Esc to cancel");
    return lines.join("\n");
  }

  private review(): string {
    const lines = [RULE, this.tabRow(), "", "Review your answers", ""];
    if (this.answered.some((done) => !done)) lines.push("⚠ You have not answered all questions", "");
    lines.push("Ready to submit your answers?", "");
    lines.push(`${this.cursor === 0 ? "❯" : " "} 1. Submit answers`);
    lines.push(`${this.cursor === 1 ? "❯" : " "} 2. Cancel`);
    return lines.join("\n");
  }

  /** Applies a run of bytes one key at a time, the way a pane receives them. */
  send(bytes: Uint8Array): void {
    for (const token of tokens(new TextDecoder().decode(bytes))) this.key(token);
  }

  private key(token: string): void {
    if (this.closed) return;
    if (this.tab >= this.questions.length) return this.reviewKey(token);
    const at = this.tab;
    if (this.twoColumn(at)) return this.previewKey(at, token);
    const question = this.questions[at]!;
    const other = this.otherRow(at);
    const typing = this.cursor === other;

    // Once the cursor is in the free-text row, digits and the side arrows stop being commands.
    if (typing && token === "") {
      this.other[at] = this.other[at]!.slice(0, -1);
      return;
    }
    if (typing && (token === LEFT || token === RIGHT)) return;
    if (typing && token.length === 1 && token >= " ") {
      this.other[at] += token;
      return;
    }

    if (token === "\t") {
      // Tab leaves the text row onto the inline button; anywhere else it is a tab step.
      if (typing && question.multiSelect) this.cursor = other + 1;
      else this.step(1);
      return;
    }
    if (token === UP || token === DOWN) {
      const moved = this.cursor + (token === DOWN ? 1 : -1);
      this.cursor = Math.max(0, Math.min(this.rowCount(at) - 1, moved));
      return;
    }
    if (token === LEFT) return this.step(-1);
    if (token === RIGHT) return this.step(1);

    const row = token === "\r" ? this.cursor : Number(token) - 1;
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount(at)) return;
    this.press(at, row);
  }

  /** What pressing a row does, which is where the three meanings of one digit live. */
  private press(at: number, row: number): void {
    const question = this.questions[at]!;
    const other = this.otherRow(at);
    if (question.multiSelect) {
      if (row === other + 1) return this.step(1); // the inline button, which only ever steps on
      if (row === other) this.otherTicked[at] = !this.otherTicked[at];
      else if (this.ticked[at]!.has(row)) this.ticked[at]!.delete(row);
      else this.ticked[at]!.add(row);
      this.answered[at] = this.ticked[at]!.size > 0 || this.otherTicked[at]!;
      return;
    }
    if (row === other) {
      // On this shape the digit only moves the cursor here; Enter is what commits the text.
      if (this.cursor !== other) {
        this.cursor = other;
        return;
      }
      this.chosen[at] = -1;
      this.answered[at] = true;
      this.advance();
      return;
    }
    this.chosen[at] = row;
    this.answered[at] = true;
    this.advance();
  }

  /**
   * What each key does on a two-column question, which is not what it does anywhere else.
   *
   * A digit only moves the cursor here and Enter is what selects. Once `Notes` has the keyboard it
   * takes everything as text except Enter, which commits it and advances -- Tab and the arrows
   * included, both measured typed rather than obeyed.
   */
  private previewKey(at: number, token: string): void {
    const question = this.questions[at]!;
    if (this.noteCaret !== null) {
      if (token === "\r") {
        this.noteGiven[at] = true;
        this.answered[at] = true;
        this.noteCaret = null;
        this.advance();
        return;
      }
      if (token === END_OF_LINE) {
        this.noteCaret = this.notes[at]!.length;
        return;
      }
      if (token === DELETE) {
        if (this.noteCaret === 0) return;
        const held = this.notes[at]!;
        this.notes[at] = held.slice(0, this.noteCaret - 1) + held.slice(this.noteCaret);
        this.noteCaret -= 1;
        return;
      }
      if (token.length !== 1 || token < " ") return;
      const held = this.notes[at]!;
      this.notes[at] = held.slice(0, this.noteCaret) + token + held.slice(this.noteCaret);
      this.noteCaret += 1;
      return;
    }
    if (token === "n") {
      this.noteCaret = 0;
      return;
    }
    if (token === UP || token === DOWN) {
      const moved = this.cursor + (token === DOWN ? 1 : -1);
      this.cursor = Math.max(0, Math.min(question.options.length - 1, moved));
      return;
    }
    if (token === LEFT) return this.step(-1);
    if (token === RIGHT || token === "\t") return this.step(1);
    if (token === "\r") {
      this.chosen[at] = this.cursor;
      this.answered[at] = true;
      this.advance();
      return;
    }
    const row = Number(token) - 1;
    // The whole difference from the one-column shape: the digit moves the cursor and does no more.
    if (Number.isInteger(row) && row >= 0 && row < question.options.length) this.cursor = row;
  }

  private reviewKey(token: string): void {
    if (token === UP || token === DOWN) {
      this.cursor = token === DOWN ? 1 : 0;
      return;
    }
    if (token === LEFT) return this.step(-1);
    if (token === RIGHT) return; // clamps
    const row = token === "\r" ? this.cursor : Number(token) - 1;
    if (row === 0) this.closed = "submitted";
    if (row === 1) this.closed = "cancelled";
  }

  /**
   * What answering a question does next.
   *
   * A lone single-select question has no Submit tab and no next tab, so the press that answers it
   * submits the whole dialog. Anything else steps forward a tab.
   */
  private advance(): void {
    if (this.hasSubmitTab) this.step(1);
    else this.closed = "submitted";
  }

  /** Moves between tabs, clamping at both ends, and lands the cursor on the first row. */
  private step(by: number): void {
    const next = Math.max(0, Math.min(this.questions.length, this.tab + by));
    if (next === this.tab) return;
    this.tab = next;
    this.cursor = 0;
  }

  /** What the dialog would report as this question's answer. */
  answerFor(at: number): string[] {
    const question = this.questions[at]!;
    if (this.twoColumn(at)) {
      // A note and a chosen option can both stand on one of these, which is why this is a list
      // rather than one or the other.
      const picked = this.chosen[at]! >= 0 ? [question.options[this.chosen[at]!]!] : [];
      return this.noteGiven[at] ? [...picked, this.notes[at]!] : picked;
    }
    if (!question.multiSelect) {
      if (this.chosen[at] === -1) return [this.other[at]!];
      return this.chosen[at]! >= 0 ? [question.options[this.chosen[at]!]!] : [];
    }
    const picked = [...this.ticked[at]!].sort().map((index) => question.options[index]!);
    return this.otherTicked[at] ? [...picked, this.other[at]!] : picked;
  }
}

const UP = "[A";
const DOWN = "[B";
const RIGHT = "[C";
const LEFT = "[D";

/** Splits a byte run into keys, so a repeated Backspace arrives as several presses. */
function tokens(keys: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < keys.length;) {
    if (keys[at] === "" && keys[at + 1] === "[") {
      let end = at + 2;
      while (end < keys.length && !/[A-Za-z~]/.test(keys[end]!)) end += 1;
      out.push(keys.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    out.push(keys[at]!);
    at += 1;
  }
  return out;
}
