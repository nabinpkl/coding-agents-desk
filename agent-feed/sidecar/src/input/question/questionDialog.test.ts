import { expect, test } from "bun:test";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";
import { CAPTURES } from "@/input/question/questionCaptures";
import {
  isPlaceholder,
  otherRowIndex,
  questionDialog,
} from "@/input/question/questionDialog";

function pane(screen: string): TmuxPaneView {
  return { screen, cursor: { row: 0, column: 0 } };
}

/**
 * A row printed back the way the pane drew it, so the fixture stays a transcription.
 *
 * Every piece the parser lifts out into a field goes back in: a failure then names the row that
 * moved rather than a field somebody has to map onto a screen by hand.
 */
function shown(row: {
  number: number | null;
  text: string;
  cursor: boolean;
  ticked: boolean | null;
  chosen: boolean;
}): string {
  const box = row.ticked === null ? "" : row.ticked ? "[\u2714] " : "[ ] ";
  return `${row.cursor ? ">" : " "}${row.number ?? ""}. ${box}${row.text}${row.chosen ? " \u2714" : ""}`;
}

// The whole point of the captures module: every shape the renderer produces, read once. A
// synthetic screen would only ever assert what the author already believed.
for (const capture of CAPTURES) {
  test(`reads ${capture.name}`, () => {
    const dialog = questionDialog(pane(capture.screen));
    expect(dialog).not.toBeNull();
    expect(dialog!.tabs.map((tab) => tab.label)).toEqual([...capture.tabs]);
    expect(dialog!.question).toBe(capture.question);
    expect(dialog!.review).toBe(capture.review);
    expect(dialog!.multiSelect).toBe(capture.multiSelect);
    expect(dialog!.rows.filter((row) => !row.button).map(shown)).toEqual([...capture.rows]);
  });
}

test("the tab row says which questions still need an answer", () => {
  const dialog = questionDialog(pane(capture("three questions, two answered")))!;
  expect(dialog.tabs.map((tab) => `${tab.label}:${tab.answered}:${tab.submit}`)).toEqual([
    "One:true:false",
    "Two:true:false",
    "Three:false:false",
    // The Submit entry draws `✔` rather than a state box, so it is never "answered".
    "Submit:false:true",
  ]);
});

test("an answered single-select row is the one with the trailing tick, not the cursor", () => {
  const dialog = questionDialog(pane(capture("three questions, two answered")))!;
  // The cursor sits back on row one while row two holds the answer. Reading the cursor as the
  // answer would be wrong on every question somebody has already been through.
  expect(dialog.rows[0]!.cursor).toBe(true);
  expect(dialog.rows[0]!.chosen).toBe(false);
  expect(dialog.rows[1]!.cursor).toBe(false);
  expect(dialog.rows[1]!.chosen).toBe(true);
  expect(dialog.rows[1]!.text).toBe("BBB");
});

test("a multi-select row reports its own box, and the free-text row has one too", () => {
  const dialog = questionDialog(pane(capture("multi-select with typed free text")))!;
  expect(dialog.rows.map((row) => row.ticked)).toEqual([true, false, true, null]);
  // The last entry is the inline button, which carries no number and is not an answer.
  const button = dialog.rows[dialog.rows.length - 1]!;
  expect(button.button).toBe(true);
  expect(button.text).toBe("Next");
  expect(button.number).toBeNull();
});

test("the inline button reads Submit on a lone question and Next when one follows", () => {
  const lone = questionDialog(pane(capture("one multi-select question")))!;
  const middle = questionDialog(pane(capture("multi-select with typed free text")))!;
  expect(lone.rows.find((row) => row.button)!.text).toBe("Submit");
  expect(middle.rows.find((row) => row.button)!.text).toBe("Next");
});

test("the free-text row is the last numbered one, and says whether anybody typed in it", () => {
  const empty = questionDialog(pane(capture("one single-select question")))!;
  const typed = questionDialog(pane(capture("multi-select with typed free text")))!;
  expect(empty.rows[otherRowIndex(empty)]!.text).toBe("Type something.");
  expect(isPlaceholder(empty.rows[otherRowIndex(empty)]!.text)).toBe(true);
  expect(typed.rows[otherRowIndex(typed)]!.text).toBe("typed on the multi other");
  expect(isPlaceholder(typed.rows[otherRowIndex(typed)]!.text)).toBe(false);
});

test("`Chat about this` is outside the box and is never an answer row", () => {
  for (const capture of CAPTURES) {
    const dialog = questionDialog(pane(capture.screen))!;
    expect(dialog.rows.map((row) => row.text)).not.toContain("Chat about this");
  }
});

test("the review screen is found without a footer or a closing rule", () => {
  const dialog = questionDialog(pane(capture("the review screen")))!;
  expect(dialog.review).toBe(true);
  expect(dialog.question).toBeNull();
  expect(dialog.rows.map((row) => row.text)).toEqual(["Submit answers", "Cancel"]);
  // Still reads the tab row, which is what says whether every question got an answer.
  expect(dialog.tabs.map((tab) => tab.label)).toEqual(["Toppings", "Submit"]);
});

test("a wrapped label is read as its start, because the rest is indistinguishable from prose", () => {
  // Taken at 60 columns off the same session: the label continues on a row indented exactly like
  // the description under it, so nothing can separate them and only the prefix is recoverable.
  const dialog = questionDialog(pane([
    "────────────────────────────────────────────────────────────",
    " ☐ Long",
    "",
    "Pick one?",
    "",
    "❯ 1. INDIA a deliberately very long option label written out",
    "     at length so that it certainly exceeds the width of a",
    "     terminal pane and has to wrap or truncate",
    "     Extensive option requiring careful layout handling.",
    "  2. JULIETT",
    "     Concise alternative for comparison.",
    "  3. Type something.",
    "────────────────────────────────────────────────────────────",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n")))!;
  expect(dialog.rows).toHaveLength(3);
  expect(dialog.rows[0]!.text).toBe("INDIA a deliberately very long option label written out");
  expect(dialog.rows[1]!.text).toBe("JULIETT");
});

test("a pane with no dialog on it reads as none", () => {
  expect(questionDialog(pane("❯ typing away\n───────────\n  status line"))).toBeNull();
  expect(questionDialog(pane(""))).toBeNull();
  // A footer with no rules above it is a pane mid-redraw, not a dialog with no rows.
  expect(questionDialog(pane("Enter to select · Esc to cancel"))).toBeNull();
});

function capture(name: string): string {
  const found = CAPTURES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no capture named ${name}`);
  return found.screen;
}

test("a footer wrapped across two rows still finds the dialog", () => {
  // The failure this reader had on every 80-column pane: the footer is one logical line the pane
  // broke in two, so nothing on screen contained the anchor and a dialog plainly up read as none.
  // The driver took that for the question having moved on and refused -- after it had already
  // ticked a box, while the panel said nothing was sent.
  const wrapped = capture("multi-select mid-answer on an 80-column pane");
  expect(wrapped.split("\n").some((line) => line.includes("Esc to cancel"))).toBe(false);

  const dialog = questionDialog(pane(wrapped))!;
  expect(dialog.question).toBe("Which days?");
  expect(dialog.rows.find((row) => row.button)!.text).toBe("Next");
  // The free-text row is where the cursor is, which is what put the `ctrl+g` hint in the footer.
  expect(otherRowIndex(dialog)).toBe(3);
  expect(dialog.rows[otherRowIndex(dialog)]!.cursor).toBe(true);

  // Identical to the same screen with four more columns to draw that footer in.
  const roomy = questionDialog(pane(wrapped.replace("· Esc\nto cancel", "· Esc to cancel")))!;
  expect(dialog.rows.map((row) => row.text)).toEqual(roomy.rows.map((row) => row.text));
  expect(dialog.tabs.map((tab) => tab.label)).toEqual(roomy.tabs.map((tab) => tab.label));
});
