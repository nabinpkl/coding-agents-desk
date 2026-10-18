// Reading Claude's prompt box out of a pane's screen.
//
// The screen is text with escapes in it, and the box is a run of rows between two rules
// with a `❯` at the head of the first. Everything here is that reading: where the box is,
// what is in it, whether a faint row is a hint rather than typing, and what the command
// menu under it says.
//
// The measurements about how Claude draws all of that are in `tmuxComposer.ts`'s header,
// because they are what the whole module was built against.

import type { ComposerCommand } from "@agentdesk/agent-feed-wire";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";

/** The character Claude draws at the head of its prompt box. */
const PROMPT = "❯";
/**
 * What separates the marker from the text, and it is not an ordinary space.
 *
 * Claude writes a NO-BREAK space there, measured on a live pane (`\u276f\u00a0make the...`). An
 * ordinary-space strip therefore left one character of padding at the head of every reading, which
 * the panel would then have pushed back into the box as if the reader had typed it.
 */
const GAP = /^[ \u00a0]/;
/** Continuation rows are indented by two ORDINARY spaces, to sit under the text. */
const INDENT = "  ";
/**
 * How much box drawing makes a line a rule.
 *
 * A run rather than a whole-line test, because a rule carries a label: the pane's own title is
 * drawn into the top one. Eight is far more than prose contains and far less than any rule.
 */
const RULE = /─{8}/;
/**
 * The top rule when the title drawn into it is wider than the pane.
 *
 * Claude cuts the title with `…` and keeps only the rule's last segment, so the row is
 * ` Curtis (2026 oct 6 search for gitlab transcent hackathon and prepare context… ─`: one `─`,
 * which `RULE` cannot see. Measured 2026-10-17 on 2.1.301 and 2.1.302 alike, on an 80-column
 * pane; every Bot pane restarted that night came back at 80 columns, and a session with a long
 * title read as having no composer at all.
 */
const TITLE_ROW = / ─$/;
/** Every colour and style run, which the screen carries because one of them is load-bearing. */
const SGR = /\u001b\[[0-9;]*m/g;
/** One such run at the head of what is left, with its parameters, for asking whether it is dim. */
const SGR_HEAD = /^\u001b\[([0-9;]*)m/;
/**
 * The SGR parameter for faint text, which is how Claude draws a composer PLACEHOLDER.
 *
 * Measured on a live pane after a turn: `\u001b[39m❯\u00a0\u001b[2m<no suggestion>\u001b[0m`. With the
 * escapes stripped that is indistinguishable from somebody having typed those words, and the
 * mirror would have filled a reader's field with it and then typed it back into the session. It is
 * the only thing on the screen that says otherwise.
 */
const FAINT = "2";

/**
 * What Claude collapses an attachment into, and treats as a SINGLE character.
 *
 * Measured on a live pane, both kinds. With `[Image #2] omega` in the box, six backspaces rubbed
 * out " omega" one character at a time and the SEVENTH took the whole token; the same held for
 * `[Pasted text #3 +38 lines]`, twenty-six characters that went in one press. So the count of
 * backspaces a correction needs is not the length of the text being removed, and a diff that used
 * the length would delete as many extra characters to the left as the token is long.
 *
 * Both kinds matter even though the panel only ever creates images: a person typing in the pane
 * makes the other one by pasting anything long, and this side has to read their box correctly.
 */
export const ATTACHMENT = /\[(?:Image|Pasted text) #\d+(?: \+\d+ lines)?\]/g;

/**
 * One row of the command menu: two spaces, the name, a gap, and the description.
 *
 * The name is deliberately narrow -- letters, digits and the few separators a command may carry,
 * and NO second slash. Claude draws the menu into the same rows the status lines use, and a status
 * line showing a path would otherwise read as a command called `/Users`.
 */
const MENU_ENTRY = /^ {2}(\/[A-Za-z0-9][A-Za-z0-9:_.-]*) {2,}(\S.*)$/;

/**
 * A row that continues the description above it, which is indented to the description's column.
 *
 * Told from an entry by having more than the entry's two spaces in front of it, rather than by the
 * column itself, which is a width this does not want to depend on.
 */
const MENU_WRAP = /^ {3,}(\S.*)$/;

/** What the box is showing: what is in it, and what Claude is offering to put there. */
export interface ComposerBox {
  /**
   * How many Ctrl+U certainly empty this box, even if the pane reflows before they arrive.
   *
   * Not `rows.length`. That is the count the screen showed, and the screen can be out of date by
   * the time the keystrokes land; see `NARROWEST_PANE` for what that costs and why overshooting
   * is the answer rather than serialising against whoever resized the pane.
   */
  clearPresses: number;
  /**
   * The composer's rows as the screen shows them.
   *
   * Rows rather than text, because the ROW COUNT is exact where the text is not, and it is the
   * row count that clearing depends on.
   */
  rows: string[];
  /** Claude's suggestion, when the box is holding one instead of somebody's text. */
  hint: string | null;
  /**
   * Whether `rows` is the whole truth and the cursor is sitting at the end of it.
   *
   * False means the reading is a LOWER BOUND on what the box holds, so only a clear and a retype
   * is safe. Two things make it false and both are invisible in the text: a cursor parked
   * somewhere other than the end of the last row, and trailing whitespace past that cursor which
   * the capture cannot show because tmux pads every row to the pane width anyway.
   *
   * It is false rarely, which is what makes paying a retype for it reasonable. The obvious worry
   * is a session mid-answer, where a retype would also detach any image in the box by retyping its
   * token as text -- so it was measured rather than assumed: across a seventeen-second turn, read
   * every 700ms, the cursor stayed inside the composer and the reading was exact throughout.
   */
  exact: boolean;
  /**
   * The command menu drawn under the box, or empty when there is none.
   *
   * Part of reading the box rather than a second read of the same screen: the menu lives in the
   * rows immediately below the box's closing rule, so whatever walked the box already knows where
   * it starts.
   */
  commands: ComposerCommand[];
}

/**
 * Where the composer's text starts, in the pane's own columns.
 *
 * The marker and its gap are two columns, and a continuation row is indented by two spaces, so
 * one number covers both. Measured 2026-09-08: an empty box reports the cursor at column 2, and
 * the start of a wrapped box's second row is column 2 as well.
 */
/**
 * The narrowest pane a clear has to survive being reflowed into.
 *
 * The row count comes from a screen read, and the pane can change shape between that read and the
 * send: `inTurn` serialises composer turns against each other, but nothing serialises them against
 * `adoptPaneSize`, which any viewer reaches by publishing a viewport -- a card being dragged or a
 * phone rotating is enough, with no second viewer anywhere. Narrowing is the hazard, because the
 * same text then occupies MORE rows than were counted and the leftover rows survive the clear for
 * the paste to land on top of.
 *
 * Measured 2026-09-08 by reflowing a pane inside the turn: a two-row box at 132 columns, reflowed
 * to 40 and pushed `replaced entirely`, came back holding the whole original sentence with
 * `replaced entirely` on the end. The reader's words twice, which is this module's oldest bug
 * arriving through a door that only opened when panes started being resized at all.
 *
 * The fix is to overshoot, because overshooting is free: measured on the same pane, twenty Ctrl+U
 * against a three-character box and against an already-empty one both left it empty and typing
 * afterwards behaved normally. So the count is what the text would need at a pane this narrow.
 * Twenty is a floor rather than a measurement -- a composer in a pane narrower than that is not
 * usable by a person -- and it is stated here rather than buried so the next reader can raise it.
 */
const NARROWEST_PANE = 20;

const BOX_COLUMN = 2;

/** What the composer box holds, or null when the screen shows no box at all. */
export function composerBox(view: TmuxPaneView): ComposerBox | null {
  const raw = view.screen.split("\n");
  const lines = raw.map(plainText);
  const head = lastPromptRow(lines);
  if (head === null) return null;
  const closing = closingRule(lines, head);
  // Where the box's rows stop. The closing rule is the authority when there is one, because a row
  // holding NOTHING is still one of the box's rows: a composer whose text ends exactly at a wrap
  // boundary draws an empty row and parks the caret on it, and tmux pads that row out to the pane
  // width, so `plainText` trims it to "" and it is indistinguishable from blank screen by looking
  // at it. Reading it as the end of the box under-counted the rows by one, which is the count the
  // clear is sized from -- and it put the cursor a row below the last one the reading knew about,
  // so the reading was called inexact when it was merely short.
  //
  // Without a rule there is no authority, so the scan stops at the first row that has left the
  // box, EMPTY INCLUDED. That is the conservative half of the same question: the status lines are
  // indented too, and a redraw that dropped the rule would otherwise swallow the whole footer.
  const end = closing === -1 ? unclosedEnd(lines, head) : closing;
  const below = closing === -1 ? lines.length : closing + 1;
  /** How many visual rows the box is DRAWN across, which is what a clear actually has to kill. */
  const drawn = Math.max(1, end - head);
  // A suggestion fills the box and IS the box, so the composer reads as empty and the suggestion
  // travels separately. Asked of the RAW row, because the answer is in the escapes.
  if (isPlaceholder(raw[head]!)) {
    return {
      rows: [""],
      hint: lines[head]!.slice(PROMPT.length).replace(GAP, "") || null,
      // Corroborated by the cursor, which is the one thing on this screen that can disagree.
      //
      // This branch is the weakest claim in the module: it says a box is EMPTY on the evidence of
      // a colour, and it has been wrong once already -- every truecolor run was read as faint, so
      // a reader's own sentence read as a suggestion, the box read as empty, and every push then
      // pasted the whole draft on top of what was in it. A suggestion sits in a box with nothing
      // in it, and an empty box parks the caret at the start of the marker row: measured
      // 2026-09-09, an empty composer reports the cursor at (marker row, column 2) and a typed
      // one reports it further along the same row.
      //
      // So a row that LOOKS faint while the caret is somewhere else is not taken at its word. It
      // is still read as a placeholder -- rejecting it outright would risk mirroring a real
      // suggestion into a reader's field, which is the older and worse bug -- but it is marked
      // inexact, which sends it down the clear-and-retype path. The cost of this check being
      // wrong is therefore one retype, and the cost of it being absent was somebody's sentence.
      exact: view.cursor.row === head && view.cursor.column <= BOX_COLUMN,
      // A menu needs text to filter, and a box holding a suggestion is a box holding nothing.
      commands: [],
      // Sized from the rows the box DRAWS, not from the one row a suggestion needs. This branch's
      // claim that the box is empty rests on a COLOUR, which is the weakest evidence anywhere in
      // this module and has been wrong once already; when it is wrong the box is full, and a clear
      // sized for the belief rather than for the screen would leave most of it standing.
      clearPresses: drawn,
    };
  }
  const rows = [lines[head]!.slice(PROMPT.length).replace(GAP, "")];
  for (let index = head + 1; index < end; index += 1) rows.push(lines[index]!.slice(INDENT.length));
  const last = rows.length - 1;
  const column = view.cursor.column - BOX_COLUMN;
  // Only when the cursor is at or past the end of the LAST row does the reading account for
  // everything: anywhere else and the rows below or beyond it may hold whitespace this cannot
  // see. Where it is past the end, the gap IS that whitespace, measured to the character, and
  // putting it back is what stops the next append inserting a space that is already there.
  const exact = view.cursor.row - head === last && column >= rows[last]!.length;
  if (exact) rows[last] = rows[last]!.padEnd(column, " ");
  return {
    rows,
    hint: null,
    exact,
    commands: menuUnder(raw, lines, below),
    // What this text would need if the pane narrowed to the floor before the keystrokes arrived,
    // never fewer than the rows actually seen.
    clearPresses: Math.max(rows.length, Math.ceil([...composerText(rows)].length / NARROWEST_PANE)),
  };
}

/**
 * The rule that closes the box, or -1 when this screen is not showing one.
 *
 * Scans only over rows that could still belong to the box -- indented, or empty -- so a screen
 * whose box is unclosed does not find some later rule further down and claim everything between.
 */
function closingRule(lines: readonly string[], head: number): number {
  for (let index = head + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (RULE.test(line)) return index;
    if (line.length > 0 && !line.startsWith(INDENT)) return -1;
  }
  return -1;
}

/** Where a box with no closing rule stops: the first row that is not indented into it. */
function unclosedEnd(lines: readonly string[], head: number): number {
  let index = head + 1;
  while (index < lines.length && lines[index]!.startsWith(INDENT)) index += 1;
  return index;
}

/**
 * The command menu Claude is drawing below the box, from the row after its closing rule.
 *
 * Claude puts this menu where the status lines usually go and runs it to the bottom of the pane,
 * so there is no terminator to find: the scan stops at the first row that is neither an entry nor
 * the wrapped tail of one, which is what the status lines are when no menu is open.
 *
 * The `@` menu shares the region and is deliberately NOT read here. Measured 2026-09-08: its rows
 * are `◇ resource – description` with no leading slash, so `MENU_ENTRY` declines them by shape
 * rather than by a flag, and a reader who opens it sees no list instead of a list of the wrong
 * things.
 */
function menuUnder(raw: string[], lines: string[], from: number): ComposerCommand[] {
  const found: Array<{ command: ComposerCommand; colour: string }> = [];
  for (let index = from; index < lines.length; index += 1) {
    const entry = MENU_ENTRY.exec(lines[index]!);
    if (entry) {
      found.push({
        command: { name: entry[1]!, description: entry[2]!.trimEnd(), selected: false },
        colour: firstColour(raw[index]!),
      });
      continue;
    }
    const wrap = found.length > 0 ? MENU_WRAP.exec(lines[index]!) : null;
    if (!wrap) break;
    const last = found[found.length - 1]!.command;
    last.description = `${last.description} ${wrap[1]!.trimEnd()}`;
  }
  // Which entry Return would run, taken as the one whose colour is not the others'. Measured on a
  // live pane: the selected row came back `38;5;153` against `38;5;246` for every other, and the
  // highlight moved with the arrow keys. Read as "the odd one out" rather than as those numbers,
  // because they are a colour scheme's and this is not the place to hold one.
  const majority = commonest(found.map((entry) => entry.colour));
  for (const entry of found) entry.command.selected = entry.colour !== majority;
  return found.map((entry) => entry.command);
}

/** The colour a menu row opens with, which is what the highlight changes. */
function firstColour(rawLine: string): string {
  // The row's own leading style comes before the two spaces; the entry's colour comes after them.
  const match = /^(?:\u001b\[[0-9;]*m)*\s*(\u001b\[[0-9;]*m)/.exec(rawLine);
  return match?.[1] ?? "";
}

/** The value that appears most often, or null when there is nothing to be commonest of. */
function commonest(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let seen = 0;
  for (const [value, count] of counts) {
    if (count <= seen) continue;
    best = value;
    seen = count;
  }
  return best;
}

/** A screen line with its colour taken off and its padding trimmed, which is what parses. */
export function plainText(line: string): string {
  return line.replace(SGR, "").replace(/\s+$/, "");
}

/**
 * Whether this prompt row is Claude's own hint rather than somebody's text.
 *
 * True when the first thing after the marker opens a faint run. Nothing a reader types arrives
 * dim, and the hint is dim from its first character, so the question is only ever asked of the
 * one position where the two could be confused.
 */
function isPlaceholder(rawPromptRow: string): boolean {
  let rest = rawPromptRow;
  // Style set before the marker is the box's own, not the text's; step over it.
  for (let head = SGR_HEAD.exec(rest); head !== null; head = SGR_HEAD.exec(rest)) {
    rest = rest.slice(head[0].length);
  }
  if (!rest.startsWith(PROMPT)) return false;
  rest = rest.slice(PROMPT.length).replace(GAP, "");
  const head = SGR_HEAD.exec(rest);
  return head !== null && setsFaint(head[1]!);
}

/**
 * Whether an SGR parameter list actually turns FAINT on.
 *
 * A walk rather than a search, and the difference is the whole of a bug that ate people's
 * sentences. This used to ask whether `2` appeared anywhere among the parameters, which is true
 * of every truecolor run there is: `38`, `48` and `58` introduce a colour whose FORM is named by
 * the parameter after them -- `5` for a 256-colour index, `2` for r;g;b -- so `38;2;255;0;0` is
 * red and `38;5;2` is green, and neither is faint. A terminal that advertises RGB is enough to
 * make Claude draw in the first form, and this repo hands sessions `COLORTERM=truecolor`
 * (`terminal/pty-manager/src/vault_sessions.rs`) while tmux carries `xterm-256color:RGB`.
 *
 * What that cost is out of all proportion to the mistake. A composer whose text is coloured that
 * way reads as a PLACEHOLDER, so the box comes back empty and exact; `keystrokesFor` then takes
 * the single-row branch, computes no backspaces because it believes there is nothing there, and
 * pastes the whole draft on top of what is already in the box. Once per keystroke, which is how a
 * reader gets every prefix of their sentence back, joined end to end.
 *
 * So the parameters are consumed in the order a terminal consumes them, and only a standalone `2`
 * is faint.
 */
function setsFaint(parameters: string): boolean {
  const parts = parameters.split(";");
  for (let at = 0; at < parts.length; at += 1) {
    // An omitted parameter is a zero, which is what makes `ESC[;2m` a reset and then a faint.
    const value = parts[at] === "" ? "0" : parts[at]!;
    if (value === "38" || value === "48" || value === "58") {
      // `5` takes one parameter after it and `2` takes three. Anything else is malformed, and
      // consuming nothing lets the walk carry on rather than swallowing the rest of the list.
      at += parts[at + 1] === "5" ? 2 : parts[at + 1] === "2" ? 4 : 0;
      continue;
    }
    if (value === FAINT) return true;
  }
  return false;
}

/**
 * The prompt row of the LAST composer box on the screen.
 *
 * Anchored on the rule above it rather than on the marker alone. Claude echoes each of the user's
 * own turns into the transcript with the same marker, so a screen holding two turns has three
 * candidate rows and only the last one is a box that can be typed into.
 *
 * A truncated title (`TITLE_ROW`) stands in for that rule only when the box below also closes on
 * one, because the closing rule is always drawn whole. That second guard is what keeps a turn
 * echoed under some line that happens to end in ` ─` from reading as the box.
 */
function lastPromptRow(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (!lines[index]!.startsWith(PROMPT)) continue;
    const above = lines[index - 1]!;
    if (RULE.test(above)) return index;
    if (TITLE_ROW.test(above) && closingRule(lines, index) !== -1) return index;
  }
  return null;
}

/**
 * The text those rows probably hold.
 *
 * Joined with a space because the wrap Claude performs is a WORD wrap, and the space it broke on
 * survives in neither row. Exact for a single row and a hypothesis for more than one, which is
 * why `exact` travels beside it all the way to the panel.
 */
export function composerText(rows: readonly string[]): string {
  return rows.join(" ");
}
