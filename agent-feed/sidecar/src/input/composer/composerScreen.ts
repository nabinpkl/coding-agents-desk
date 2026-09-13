// Reading and driving the composer of a Claude CLI that is running inside a tmux pane.
//
// The screen is the only interface a TUI has. There is no accessibility tree to read and no socket
// that answers "what is in your prompt box", so this reads `capture-pane` and writes `send-keys`,
// and every rule below is a measured property of Claude Code's own renderer (v2.1.263, on a 60
// column pane) rather than an assumption about TUIs in general:
//
//   The box is a rule line, a row beginning `❯ `, zero or more rows indented by two, and a rule.
//   An empty composer still draws it, as `❯ ` alone.
//
//   TWO things draw none of it, and they are not the same thing to whoever is reading the panel.
//   A pane mid-redraw is one, and it is over in milliseconds: measured 2026-09-09 across a burst
//   of `resize-window` calls, polling every ~5ms, the box was missing for exactly one poll -- so
//   that window is at most ~5ms and the measurement cannot say how much less. `COALESCE_MS` below
//   is what keeps the watcher out of it: ten resizes through the live watcher reported none of
//   them. The other is a DIALOG -- `/model`, `/resume`, a permission prompt -- which replaces the
//   box with an option list and stands until somebody answers it IN THE PANE. Measured the same
//   day through the live watcher: `/model` reported `no-composer` for the full fourteen seconds
//   the picker was open, clearing on Escape.
//
//   That second one is the common producer of `no-composer` and the reason the panel's own
//   wording for it must not promise the composer is coming back. Both reasons look identical
//   here, and deliberately: the box is genuinely not on the screen either way, and this module
//   reports the absence rather than guessing at a cause it cannot see.
//
//   TELLING THEM APART FROM TMUX WAS TRIED, AND DOES NOT WORK. `#{cursor_flag}` looks like the
//   answer, because Claude hides the cursor when there is nothing to type into: measured
//   2026-09-09, it reads 1 at a normal composer and 0 for as long as a `/model` picker, a
//   `/resume` list or a `Do you want to proceed?` prompt is up. But it reads 0 during a redraw
//   too. Each repaint is bracketed by `ESC[?25l` ... `ESC[?25h`, and the whole screen -- both
//   rules and every marker -- is erased and rewritten INSIDE that bracket (measured across
//   seven resizes: 30 erase-lines, 2 rules and 3 markers per bracket). So a capture taken mid-
//   redraw sees exactly what a dialog shows it. The one thing the flag does separate is a
//   session that exited: a shell prompt keeps the cursor shown, and reads 1 with no box.
//
//   Nothing else in tmux carries it either. Its vocabulary is the cursor's position, shape and
//   colour and tmux's OWN modes; there is no widget model to ask, because a pane is a cell grid.
//   Claude publishes no marker of its own: a census of every escape sequence it emits across a
//   start, a turn and a shutdown found cursor moves, SGR, erase-line, OSC 8 hyperlinks,
//   bracketed paste, focus and theme reporting, and the Kitty keyboard protocol -- no OSC 133
//   semantic prompt marking, no private payload, and no alternate screen, since it draws inline.
//   If that ever changes, OSC 133 is what would replace this parser outright.
//
//   Claude WORD-WRAPS the box itself, emitting a real row per visual line rather than letting the
//   terminal wrap. `capture-pane -J` therefore does not rejoin them -- it joins only terminal-
//   wrapped lines, which was measured on a `cat` pane and does not apply here -- and the space the
//   wrap consumed survives in neither row. So a multi-row composer cannot be reconstructed exactly.
//
//   Ctrl+U kills one VISUAL row, not the whole prompt: a four-row composer needs four of them.
//   That is the one exact lever over a composer whose text cannot be read exactly.
//
//   A TRAILING SPACE is invisible in the capture and visible in the cursor. tmux pads every
//   captured row out to the pane width, so a box holding `abc ` and one holding `abc` come back as
//   the same string; `#{cursor_x}` reported 6 against 5 for exactly that pair. So the reading is
//   only complete where the cursor is, and `ComposerBox.exact` says whether it was.
//
//   An EMPTY box is not always empty-looking. Claude draws a suggestion in it, and the only thing
//   separating that from typed words is that it is FAINT. So the screen is read with its colour
//   on, which is the one place an escape sequence here is content rather than noise. The hint
//   travels beside the text rather than as part of it, and Tab is what fills it in -- measured:
//   after a Tab the same row comes back with no faint run at all.
//
// What falls out of those three is the shape of `keystrokesFor`. An exactly-known composer is
// edited incrementally, which is what makes typing feel like typing. An inexactly-known one is
// only ever treated as a HYPOTHESIS: if the guessed text is the start of what is wanted the rest
// is appended, and if the guess was wrong the box is cleared by row count and retyped. A wrong
// guess therefore costs a retype and can never corrupt the pane, which is the property worth
// having -- the pane belongs to whoever is sitting in front of it.
//
// This file is the READING half. What the box is turned into keystrokes by lives in
// `composerKeys.ts`, who asks tmux in `composerRuntime.ts`, and the verbs a route calls in
// `composerDrive.ts`.

import type { ComposerCommand } from "@agentdesk/agent-feed-wire";
import type { TmuxPaneView } from "../../terminal/tmuxSessions.ts";

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
const BOX_COLUMN = 2;

/** What the composer box holds, or null when the screen shows no box at all. */
export function composerBox(view: TmuxPaneView): ComposerBox | null {
  const raw = view.screen.split("\n");
  const lines = raw.map(plainText);
  const head = lastPromptRow(lines);
  if (head === null) return null;
  // A suggestion fills the box and IS the box, so the composer reads as empty and the suggestion
  // travels separately. Asked of the RAW row, because the answer is in the escapes.
  if (isPlaceholder(raw[head]!)) {
    return {
      rows: [""],
      hint: lines[head]!.slice(PROMPT.length).replace(GAP, "") || null,
      // A suggestion is drawn in a box with nothing in it, so there is nothing to be inexact
      // about. Where the cursor is inside it does not change that.
      exact: true,
      // A menu needs text to filter, and a box holding a suggestion is a box holding nothing.
      commands: [],
      // One row, and it holds nothing to begin with, so nothing a reflow does to it can matter.
      clearPresses: 1,
    };
  }
  const rows = [lines[head]!.slice(PROMPT.length).replace(GAP, "")];
  let below = lines.length;
  for (let index = head + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // The closing rule, and with it the first row the menu could be on.
    if (RULE.test(line)) {
      below = index + 1;
      break;
    }
    // Anything not indented into the box has left it. The status line under the bottom rule is
    // indented too, so the rule is what usually stops this; a redraw that dropped the rule would
    // otherwise swallow the whole footer into the composer.
    if (!line.startsWith(INDENT)) break;
    rows.push(line.slice(INDENT.length));
  }
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
    clearPresses: Math.max(
      rows.length,
      Math.ceil([...composerText(rows)].length / NARROWEST_PANE),
    ),
  };
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
 */
function lastPromptRow(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (!lines[index]!.startsWith(PROMPT)) continue;
    if (!RULE.test(lines[index - 1]!)) continue;
    return index;
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

