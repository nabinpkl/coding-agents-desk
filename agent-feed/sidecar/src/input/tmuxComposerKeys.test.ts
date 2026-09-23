// The keystrokes that turn what the box holds into what the reader typed.
//
// One keystroke per keystroke where the reading is exact, a clear-and-retype where it is
// only a lower bound, and one backspace for a whole attachment token because that is what
// the box itself does.

import { expect, test } from "bun:test";
import {
  ABOVE_PROMPT,
  BACKSPACE,
  BOX_COLUMN,
  CLOSE,
  clearPressesFor,
  END,
  held,
  KILL,
  OPEN,
  paneShowing,
  RULE,
  runtime,
  screenWith,
  settle,
  typed,
  watchable,
} from "@/input/tmuxComposerHarness";
import { composerPastes, keystrokesFor } from "@/input/tmuxComposer";

test("sends nothing when the box already reads that way", () => {
  expect(keystrokesFor(held(["already there"]), "already there")).toBe("");
});

test("appends what was typed, so one keystroke costs one keystroke", () => {
  expect(keystrokesFor(held(["make the hover ring"]), "make the hover rings"))
    .toBe(`${END}${OPEN}s${CLOSE}`);
  // Including from empty, where there is no prefix to match on.
  expect(keystrokesFor(held([""]), "m")).toBe(`${END}${OPEN}m${CLOSE}`);
  // A trailing space is not in the reading -- `capture-pane` strips it -- so the next letter
  // carries it back in. That is why the append is a slice of the DRAFT rather than the character
  // that was typed: sending only "r" here would have closed up a gap the reader had put there.
  expect(keystrokesFor(held(["make the hover"]), "make the hover r"))
    .toBe(`${END}${OPEN} r${CLOSE}`);
});

test("appends onto a wrapped composer when the reconstruction holds", () => {
  // The hypothesis was right, so a long prompt keeps costing one keystroke per keystroke instead
  // of being retyped from scratch on every letter.
  expect(keystrokesFor(held(["alpha bravo", "charlie"]), "alpha bravo charlie delta"))
    .toBe(`${END}${OPEN} delta${CLOSE}`);
});

test("rubs out only what diverged on a row it knows exactly", () => {
  expect(keystrokesFor(held(["hello world"]), "hello there"))
    .toBe(`${END}${BACKSPACE.repeat(5)}${OPEN}there${CLOSE}`);
  // A pure deletion sends no paste at all.
  expect(keystrokesFor(held(["hello world"]), "hello")).toBe(END + BACKSPACE.repeat(6));
});

test("counts a backspace per code point, not per UTF-16 unit", () => {
  expect(keystrokesFor(held(["hi 🐈"]), "hi ")).toBe(END + BACKSPACE);
});

test("clears by row count and retypes when the reconstruction was wrong", () => {
  // Two rows, and what is wanted does not start with the guess -- so the guess is abandoned rather
  // than trusted. Three kills would be wrong; two is what the screen said.
  expect(keystrokesFor(held(["alpha bravo", "charlie"]), "something else entirely"))
    .toBe(`${END}${KILL.repeat(2)}${OPEN}something else entirely${CLOSE}`);
});

test("renders an escape visibly so a draft cannot smuggle a control sequence into the pane", () => {
  expect(keystrokesFor(held([""]), "\u001b[31mred")).toBe(`${END}${OPEN}\u241b[31mred${CLOSE}`);
});

test("rubs out an attachment token with ONE backspace, because that is what the box does", () => {
  // Measured on a live pane: with `[Image #2] omega` in the box, six presses took " omega" one
  // character at a time and the seventh took the whole token. Counting its characters instead
  // would have sent eleven presses and deleted four characters of whatever sat to its left.
  expect(keystrokesFor(held(["alpha [Image #2] omega"]), "alpha "))
    .toBe(END + BACKSPACE.repeat(7));
  // Twenty-six characters, one press, same as the image.
  expect(keystrokesFor(held(["[Pasted text #3 +38 lines] tail"]), ""))
    .toBe(END + BACKSPACE.repeat(6));
});

test("never splits a token, since half of one cannot be deleted", () => {
  // The shared prefix ends inside `[Image #12]` here. Counting from there would rub out the rest
  // of the token by character and then meet a token that goes whole, taking the neighbours too.
  // Backed up to the token's start, so it is six presses for " after" and one for the token,
  // then the whole tail is retyped.
  expect(keystrokesFor(held(["before [Image #12] after"]), "before [Image #1] after"))
    .toBe(`${END}${BACKSPACE.repeat(7)}${OPEN}[Image #1] after${CLOSE}`);
});

test("takes a token out of the middle without touching what sits either side", () => {
  // What removing an image from the panel's strip comes to: the token goes and the text does not.
  expect(keystrokesFor(held(["alpha [Image #2] omega"]), "alpha omega"))
    .toBe(`${END}${BACKSPACE.repeat(7)}${OPEN}omega${CLOSE}`);
});

test("goes to the end before editing, because a backspace bites wherever the cursor is", () => {
  // The assumption every branch here is written on is that the text ends at the cursor. Nothing
  // made that true. A reader on a phone breaks it by tapping in the middle of their own sentence,
  // and the arrows on the key rail break it deliberately.
  //
  // Measured on a live pane: a box reading `abXcdef` with the cursor after the X, pushed `abcdef`,
  // answered 200 and left `cdefcdef` -- five backspaces ate `abX` and stopped at the start, and
  // the paste landed at position zero instead of after `ab`. The reader sees their words twice.
  //
  // The key is Ctrl+E rather than End, measured against tmux's own cursor report: End is
  // end-of-VISUAL-LINE, so on a wrapped box it leaves the cursor at the wrap boundary and the
  // row-count clear below then spares every row under it. See `END` in the module.
  for (const [rows, desired] of [
    [[""], "typed from nothing"],
    [["hello"], "hello world"],
    [["hello world"], "hello there"],
    [["one", "two"], "something else"],
  ] as const) {
    expect(keystrokesFor(held([...rows]), desired).startsWith(END)).toBe(true);
  }
  // Nothing to do stays nothing to do: a box that already agrees is not worth a cursor move.
  expect(keystrokesFor(held(["settled"]), "settled")).toBe("");
  // Named rather than merely asserted through the constant, because the constant is the thing that
  // was wrong: a change back to either End would satisfy every line above it and reinstate the
  // defect. The comparison cannot be made against a pane in this suite -- telling end-of-line from
  // end-of-buffer needs a real cursor -- so it is made against the two sequences measured to be
  // end-of-line, which is the part a fake cannot lie about.
  expect(END).toBe("\u0005");
  for (const endOfLine of ["\u001b[F", "\u001bOF"]) {
    expect(keystrokesFor(held(["one", "two"]), "something else").startsWith(endOfLine)).toBe(false);
  }
});

test("appends one keystroke to a collapsed paste instead of re-pasting the message", () => {
  // The cost this exists to remove. Claude does not put a long paste in its box, it puts a handle
  // there: measured on a live pane, literal at 800 characters and collapsed at 801. So once a
  // draft crosses that, the box reads `[Pasted text #1]` and the draft reads nine hundred
  // characters, which share no prefix at all -- and every further keystroke fell to the
  // correction path, one backspace and a whole re-paste. Measured before this existed: three
  // keystrokes against a 900-character draft produced three fresh handles, `#25 #26 #27`.
  const words = "zebra ".repeat(150);
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", words);
  const pasted = (token: string) => store.textFor("pane-1", token);

  expect(keystrokesFor(held(["[Pasted text #1]"]), `${words}!`, pasted))
    .toBe(`${END}${OPEN}!${CLOSE}`);
  // And the push that changes nothing sends nothing, which is the commonest outcome of all: the
  // panel pushes after a debounce and the previous push has usually already landed.
  expect(keystrokesFor(held(["[Pasted text #1]"]), words, pasted)).toBe("");
});

test("matches a draft that carries the handle against the box that is holding it", () => {
  // The other direction, and it is what stops the paste being destroyed. A panel that adopted
  // `[Pasted text #1]` into its field pushes that text back; without reading through the handle
  // the box and the draft disagree, so the correction path retypes the CHARACTERS of the token
  // over the paste it stands for -- which detaches it in the pane and loses the words for good.
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", "zebra ".repeat(150));
  const pasted = (token: string) => store.textFor("pane-1", token);

  expect(keystrokesFor(held(["[Pasted text #1]"]), "[Pasted text #1]", pasted)).toBe("");
  expect(keystrokesFor(held(["[Pasted text #1]"]), "[Pasted text #1] and this", pasted))
    .toBe(`${END}${OPEN} and this${CLOSE}`);
});

test("rubs out a whole handle when the edit reaches inside the paste", () => {
  // The one case that still costs a full push, and it cannot cost less: Claude offers no way to
  // change the inside of a handle, and one backspace takes the whole thing. So the presses are
  // counted on the SCREEN text -- one for the handle -- and the message goes back whole.
  const words = "zebra ".repeat(150);
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", words);
  const pasted = (token: string) => store.textFor("pane-1", token);
  const shorter = words.slice(0, -10);

  expect(keystrokesFor(held(["[Pasted text #1]"]), shorter, pasted))
    .toBe(`${END}${BACKSPACE}${OPEN}${shorter}${CLOSE}`);
});

test("leaves a paste it did not make alone, handle and all", () => {
  // Somebody pasted at the keyboard. Nothing on this side has those words, so the handle is not
  // expanded and not retyped: appending after it is still one keystroke, which is all that can
  // honestly be offered.
  expect(keystrokesFor(held(["[Pasted text #9 +38 lines]"]), "[Pasted text #9 +38 lines] hi"))
    .toBe(`${END}${OPEN} hi${CLOSE}`);
});
