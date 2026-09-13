// Reading the box off a screen: what is in it, what Claude is offering, and the menu underneath.

import { expect, test } from "bun:test";
import { composerBox, composerText } from "./composerScreen.ts";
import { keystrokesFor } from "./composerKeys.ts";
import { TmuxUnavailable, type TmuxPaneView } from "../../terminal/tmuxSessions.ts";
import {
  BACKSPACE,
  CLOSE,
  END,
  held,
  KILL,
  OPEN,
  paneShowing,
  RULE,
  screenWith,
  typed,
  clearPressesFor,
  menuScreen,
} from "./composerFixtures.ts";

test("reads the composer box, and an empty one as empty rather than as absent", () => {
  expect(composerBox(screenWith(["make the hover ring stronger"])))
    .toEqual({ rows: ["make the hover ring stronger"], hint: null, exact: true, commands: [], clearPresses: clearPressesFor(["make the hover ring stronger"]) });
  // The distinction the whole reconciliation rests on: "" is adopted into the field, null is not.
  expect(composerBox(screenWith([]))).toEqual({ rows: [""], hint: null, exact: true, commands: [], clearPresses: clearPressesFor([""]) });
});

test("keeps every wrapped row, because the row count is what clearing costs", () => {
  const box = composerBox(screenWith([
    "the quick brown fox jumps over the lazy dog the quick",
    "brown fox jumps over the lazy dog the quick brown fox",
    "jumps over the lazy dog",
  ]));
  expect(box!.rows).toHaveLength(3);
  // Rejoined with the space the wrap consumed, which is what makes this a hypothesis and not a
  // reading. Measured on a live pane: neither row carries that space.
  expect(composerText(box!.rows)).toBe(
    "the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog",
  );
});

test("reads Claude's own hint as an empty box holding a suggestion", () => {
  // Verbatim from a live pane after a turn. Strip the escapes and this is indistinguishable from
  // a reader having typed those words, and the mirror would have filled their field with it and
  // then typed it back into the session. Faint is the only thing that says otherwise -- and the
  // suggestion is worth keeping rather than discarding, because Tab is what turns it into text.
  const screen = [
    RULE,
    "\u001b[39m❯\u00a0\u001b[2mstop adding the three suggestions\u001b[0m",
    RULE,
  ].join("\n");
  expect(composerBox(paneShowing(screen)))
    .toEqual({ rows: [""], hint: "stop adding the three suggestions", exact: true, commands: [], clearPresses: clearPressesFor([""]) });
});

test("keeps text that merely sits under a colour, because only faint means a hint", () => {
  const screen = [RULE, "\u001b[39m❯\u00a0\u001b[1mtyped in bold\u001b[0m", RULE].join("\n");
  expect(composerBox(paneShowing(screen))).toEqual({ rows: ["typed in bold"], hint: null, exact: true, commands: [], clearPresses: clearPressesFor(["typed in bold"]) });
});

test("reads a colour that merely contains a 2 as a colour, not as faint", () => {
  // The `2` in `38;2;r;g;b` is truecolor's colour SPACE and the `2` in `38;5;2` is green, and a
  // parameter search finds both. Every one of these is somebody's own typing.
  for (const colour of [
    "\u001b[38;2;255;0;0m", // truecolor red, which a terminal advertising RGB gets
    "\u001b[38;2;255;255;255m",
    "\u001b[48;2;0;0;0m", // and the same as a background
    "\u001b[38;5;2m", // 256-colour green, whose index IS 2
    "\u001b[48;5;2m",
    "\u001b[58;2;1;2;3m", // underline colour, which takes its parameters the same way
  ]) {
    const screen = [RULE, `\u001b[39m❯\u00a0${colour}what the reader typed\u001b[0m`, RULE].join("\n");
    const box = composerBox(paneShowing(screen));
    expect({ colour, rows: box?.rows, hint: box?.hint })
      .toEqual({ colour, rows: ["what the reader typed"], hint: null });
  }
  // Still a hint when the run really does turn faint on, including after a reset.
  for (const faint of ["\u001b[2m", "\u001b[0;2m", "\u001b[;2m", "\u001b[1;2m"]) {
    const screen = [RULE, `\u001b[39m❯\u00a0${faint}a suggestion\u001b[0m`, RULE].join("\n");
    expect(composerBox(paneShowing(screen))?.rows).toEqual([""]);
  }
});

test("appends to a coloured composer instead of pasting the whole draft onto it", () => {
  // The reader's bug, at the layer where it cost them their sentence. A composer misread as a
  // placeholder comes back EMPTY and EXACT, so this branch computes no backspaces -- there is
  // nothing to rub out -- and pastes the whole desired text on top of what is really in the box.
  // Once per keystroke, which is how every prefix of a sentence ends up in the pane joined end to
  // end, while the panel's own field goes on showing it correctly.
  const screen = [RULE, "\u001b[39m❯\u00a0\u001b[38;2;200;200;200mhello wor\u001b[0m", RULE].join("\n");
  const box = composerBox(paneShowing(screen))!;
  expect(composerText(box.rows)).toBe("hello wor");
  // One keystroke costs one keystroke, and nothing is retyped over what is already there.
  expect(typed(keystrokesFor(box, "hello worl"))).toBe("l");
});

test("takes the last box, not a turn the transcript echoed with the same marker", () => {
  const screen = [
    RULE,
    "❯\u00a0an earlier turn, already sent",
    RULE,
    "  Claude answered it.",
    RULE,
    "❯\u00a0what is being typed now",
    RULE,
  ].join("\n");
  expect(composerBox(paneShowing(screen))).toEqual({ rows: ["what is being typed now"], hint: null, exact: true, commands: [], clearPresses: clearPressesFor(["what is being typed now"]) });
});

test("answers nothing for a screen mid-redraw, which is retryable rather than broken", () => {
  // The composer box genuinely vanishes between frames; measured on a live pane right after a
  // Ctrl+U. Reporting "" here would push an empty composer into the reader's field.
  expect(composerBox({ screen: ["  adprobe  Opus 5", "  ⏵⏵ auto mode on"].join("\n"), cursor: { row: 1, column: 2 } })).toBeNull();
  // A marker with no rule above it is transcript text, not a box.
  expect(composerBox({ screen: ["  output", "❯\u00a0quoted, in a message"].join("\n"), cursor: { row: 1, column: 2 } })).toBeNull();
});

/**
 * A live capture of a `/model` picker, taken 2026-09-09 on an 80-column pane at the moment the
 * watcher reported `no-composer`. Rows in the middle of the option list are dropped, and the
 * colour is kept on the rows that carried it verbatim and dropped from the prose rows, which
 * `plainText` strips either way before anything looks at them.
 *
 * Kept from a real screen rather than hand-written because it is what produced the reader-facing
 * message, and because a hand-written one would not have thought to include the trap: this screen
 * holds a rule, and TWO `❯` that are not composers.
 */
const MODEL_PICKER = [
  "  - If this was a misfire, re-send the command you meant.",
  "",
  "\u001b[38;5;246m✻\u001b[39m Churned for 9s · done 2:28 AM",
  "",
  // The reader's own turn, echoed into the transcript with the same marker. No rule above it.
  "\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;231m/model\u001b[39m",
  "",
  `\u001b[38;5;153m\u001b[49m${"─".repeat(80)}`,
  "\u001b[39m  \u001b[1m\u001b[38;5;153mSelect model\u001b[0m",
  "  Switch between Claude models. Your pick becomes the default for new",
  "  sessions. For other/previous model names, specify with --model.",
  "",
  "    1. Default (recommended)  Opus 5 with 1M context · Best for everyday,",
  "                              complex tasks",
  // The trap: a marker that is a menu cursor. Indented, and the only rule on the screen is seven
  // rows above it rather than directly over it, so both of `lastPromptRow`'s guards decline it.
  "  \u001b[38;5;153m❯\u001b[39m 2. \u001b[38;5;114mOpus (1M context)\u001b[39m ✔    Opus 5 with 1M context · Best for",
  "                              complex tasks",
  "    3. Fable                  Fable 5.1 · Most capable for your hardest and",
  "",
  "  ● High effort (default) ←/→ to adjust",
  "",
  "  Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

test("answers nothing for a dialog, whose menu cursor is not a prompt to type into", () => {
  // The other producer of `no-composer`, and the one a reader actually meets: a picker replaces
  // the box entirely and stands until somebody answers it in the pane. Measured 2026-09-09
  // through the live watcher, `/model` held this state for fourteen seconds.
  //
  // The reason this is a test rather than a note: the obvious way to stop the panel saying "no
  // composer" is to widen `lastPromptRow`, and this screen is what each widening costs. Both of
  // its guards are load-bearing here, and they fail differently.
  //
  //   Drop the RULE anchor and the scan reaches row 4, the reader's own `/model` echoed into the
  //   transcript, and the mirror puts "/model" in their field as text they appear to have typed.
  //
  //   Trim the row before matching the marker as well, and it reaches row 13, the menu cursor:
  //   the field fills with "2. Opus (1M context) ✔ Opus 5 with 1M context · Best for", and the
  //   next push types that back into a picker where every keystroke is a selection.
  //
  // Declining is the correct answer, and it has to stay expensive to undo by accident.
  expect(composerBox({ screen: MODEL_PICKER, cursor: { row: 13, column: 2 } })).toBeNull();
});

test("recovers the trailing space the capture cannot show, from the cursor's column", () => {
  // tmux pads every captured row to the pane width, so a box holding "abc " and one holding "abc"
  // come back as the same string and `plainText` trims both to "abc". The cursor is the only thing
  // that can tell them apart. Measured on a live pane against a box starting at column 2: "abc"
  // reported column 5, "abc " reported 6, and "abc   " reported 8.
  expect(composerBox(screenWith(["abc"], { row: 0, column: 3 }))!.rows).toEqual(["abc"]);
  expect(composerBox(screenWith(["abc"], { row: 0, column: 4 }))!.rows).toEqual(["abc "]);
  expect(composerBox(screenWith(["abc"], { row: 0, column: 6 }))!.rows).toEqual(["abc   "]);
});

test("calls a reading inexact when the cursor is anywhere but the end of the last row", () => {
  // Everything past the cursor is unknowable: the capture pads with spaces either way, so a box
  // whose cursor sits in the middle may hold trailing whitespace this cannot see, and the rows
  // BELOW the cursor may too.
  expect(composerBox(screenWith(["abcdef"]))!.exact).toBe(true);
  expect(composerBox(screenWith(["abcdef"], { row: 0, column: 3 }))!.exact).toBe(false);
  expect(composerBox(screenWith(["one", "two"]))!.exact).toBe(true);
  expect(composerBox(screenWith(["one", "two"], { row: 0, column: 3 }))!.exact).toBe(false);
  // A box drawn with nothing in it has nothing to be inexact about, suggestion or no suggestion.
  expect(composerBox(screenWith([]))!.exact).toBe(true);
});

test("clears for the narrowest pane the box could reflow into, not the one it was read in", () => {
  // The row count comes from a screen read and the pane can change shape before the keystrokes
  // land: nothing serialises a composer turn against `adoptPaneSize`, which any viewer reaches by
  // publishing a viewport -- a card dragged, a phone rotated, no second viewer needed. Narrowing
  // is the hazard, because the same text then occupies more rows than were counted and the
  // leftovers survive the clear.
  //
  // Measured on a live pane before this: a two-row box at 132 columns, reflowed to 40 inside the
  // turn and pushed "replaced entirely", came back holding the whole original sentence with
  // "replaced entirely" on the end. Overshooting is what fixes it, and overshooting is free --
  // twenty Ctrl+U against a three-character box and against an empty one both left it empty.
  const wide = composerBox(screenWith([
    "the quick brown fox jumps over the lazy dog and then keeps running well past the end",
    "of any one line at all",
  ]))!;
  expect(wide.rows).toHaveLength(2);
  // 105 characters would need six rows at the twenty-column floor, so two is not enough to send.
  expect(wide.clearPresses).toBeGreaterThan(wide.rows.length);
  expect(keystrokesFor(wide, "replaced entirely"))
    .toBe(`${END}${KILL.repeat(wide.clearPresses)}${OPEN}replaced entirely${CLOSE}`);

  // A short box needs no more than the rows it has, so the common case pays nothing.
  const small = composerBox(screenWith(["one", "two"]))!;
  expect(small.clearPresses).toBe(2);
});

test("retypes rather than edits when the reading is only a lower bound", () => {
  // An append would land after whitespace nobody can see, and a backspace count taken from the
  // visible text would rub out one character too few. Ctrl+U needs neither: it kills a whole
  // visual row whatever is in it, and the row COUNT is exact even when the text is not.
  const inexact = { rows: ["hello"], hint: null, exact: false, commands: [], clearPresses: 1 };
  expect(keystrokesFor(inexact, "hello world"))
    .toBe(`${END}${KILL}${OPEN}hello world${CLOSE}`);
  // Including when the box already reads the way it is being asked to: what it reads is not all
  // it holds, so "nothing to do" would leave the invisible tail in place.
  expect(keystrokesFor(inexact, "hello")).toBe(`${END}${KILL}${OPEN}hello${CLOSE}`);
});

test("does not insert a space that is already in the box", () => {
  // The whole point of reading the cursor. A reader typing "hello world" pauses after the space,
  // which pushes "hello " and leaves the box holding it; the capture says "hello", so the next
  // push appends " world" onto a box that already ends in a space. Measured on a live pane before
  // the cursor was read: the box came back holding "hello  world".
  const held = composerBox(screenWith(["hello"], { row: 0, column: 6 }))!;
  expect(composerText(held.rows)).toBe("hello ");
  expect(keystrokesFor(held, "hello world")).toBe(`${END}${OPEN}world${CLOSE}`);
});



test("reads the command menu Claude draws under the box, and rejoins a wrapped description", () => {
  // Captured from a live pane after pasting "/re". The selected row is a different colour from
  // the rest -- 153 against 246 here -- and the arrows move which one carries it.
  const box = composerBox(menuScreen([
    "\u001b[39m  \u001b[38;5;153m/\u001b[1mre\u001b[0m\u001b[38;5;153mcap                          Generate a one-line session \u001b[1mre\u001b[0m\u001b[38;5;153mcap now\u001b[39m",
    "  \u001b[38;5;246m/\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246msume                         \u001b[1m\u001b[39mRe\u001b[0m\u001b[38;5;246msume a previous conversation\u001b[39m",
    "  \u001b[38;5;246m/\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246mwind\u001b[39m                         \u001b[1mRe\u001b[0m\u001b[38;5;246mstore\u001b[39m \u001b[38;5;246mthe code and/or conversation to a\u001b[39m",
    "                                  \u001b[38;5;246mp\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246mvious point\u001b[39m",
  ], "/re"))!;
  expect(box.commands).toEqual([
    { name: "/recap", description: "Generate a one-line session recap now", selected: true },
    { name: "/resume", description: "Resume a previous conversation", selected: false },
    {
      name: "/rewind",
      // The two rows it wrapped onto, rejoined. Claude wraps the description itself, so the row
      // break is a rendering and not part of what it says.
      description: "Restore the code and/or conversation to a previous point",
      selected: false,
    },
  ]);
});

test("reads no menu out of the status lines that stand in the same rows", () => {
  // What is under the box when nothing is open, verbatim. The menu is drawn INTO these rows, so
  // "is there a menu" and "is this the footer" are one question, answered by shape.
  const box = composerBox(menuScreen([
    "\u001b[39m  \u001b[38;5;246mcomposer-probe  Opus 5 (1M context)  ctx:5%  5h:13%\u001b[39m",
    "  \u001b[38;5;73m⏸ plan mode on\u001b[38;5;246m (shift+tab to cycle)\u001b[39m",
    "                                                          \u001b[38;5;246m49597 tokens\u001b[39m",
  ], "ordinary text"))!;
  expect(box.commands).toEqual([]);
});

test("declines the @ menu, which shares the region and is not a list of commands", () => {
  // Measured on a live pane: its rows are `◇ resource – description` with no leading slash, so the
  // entry pattern turns them down by shape. A reader who opens it sees no list, rather than a
  // list of the wrong things.
  const box = composerBox(menuScreen([
    "\u001b[39m  \u001b[38;5;246m◇ claude.ai Figma:ui://widget/f… – figjam-diagram-mcp-app\u001b[39m",
    "  \u001b[38;5;246m◇ claude.ai Figma:skill://index… – skill-index\u001b[39m",
  ], "@"))!;
  expect(box.commands).toEqual([]);
});

test("does not read a path in the footer as a command", () => {
  // The narrow name pattern is what stops this: a command name carries no second slash, so a row
  // showing a directory declines even though it starts the same way.
  const box = composerBox(menuScreen([
    "  /Users/dev/projects/agent-desk        the working directory",
  ], "ordinary text"))!;
  expect(box.commands).toEqual([]);
});

test("stops at the bottom rule rather than swallowing the status lines", () => {
  expect(composerBox(screenWith(["hello"]))).toEqual({ rows: ["hello"], hint: null, exact: true, commands: [], clearPresses: clearPressesFor(["hello"]) });
});
