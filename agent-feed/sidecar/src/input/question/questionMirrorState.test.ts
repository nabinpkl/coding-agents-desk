import { expect, test } from "bun:test";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";
import { CAPTURES } from "@/input/question/questionCaptures";
import { questionDialog } from "@/input/question/questionDialog";
import { questionStateFrom } from "@/input/question/questionMirrorState";

function dialogFor(name: string) {
  const found = CAPTURES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no capture named ${name}`);
  const dialog = questionDialog({ screen: found.screen, cursor: { row: 0, column: 0 } } as TmuxPaneView);
  if (!dialog) throw new Error(`capture ${name} did not parse`);
  return dialog;
}

test("a single-select answer is reported by its trailing tick, not by the cursor", () => {
  const state = questionStateFrom(dialogFor("three questions, two answered"));

  // The cursor sits back on row one while row two holds the answer. A panel that followed the
  // cursor would show the reader's own choice moving to whatever row they last walked past.
  expect(state.options.map((option) => `${option.label}:${option.marked}:${option.cursor}`))
    .toEqual(["AAA:false:true", "BBB:true:false"]);
  expect(state.multiSelect).toBe(false);
  // The Submit entry is a control rather than a question, so it is not one of these.
  expect(state.tabs).toEqual([
    { label: "One", answered: true },
    { label: "Two", answered: true },
    { label: "Three", answered: false },
  ]);
});

test("a multi-select reports each row's own box, and the words in the free-text row", () => {
  const state = questionStateFrom(dialogFor("multi-select with typed free text"));

  expect(state.multiSelect).toBe(true);
  expect(state.options.map((option) => `${option.label}:${option.marked}`))
    .toEqual(["KKK:true", "LLL:false"]);
  // The free-text row is not an option, and what it holds is what somebody typed there.
  expect(state.other).toBe("typed on the multi other");
  expect(state.question).toBe("Pick many?");
});

test("Claude's own prompt in the free-text row is not somebody's answer", () => {
  const state = questionStateFrom(dialogFor("one single-select question"));

  // `Type something.` is a placeholder. Adopting it would put it in the reader's own field.
  expect(state.other).toBeNull();
  expect(state.options).toHaveLength(3);
  expect(state.review).toBe(false);
});

test("the review screen says so, and carries which questions are still unanswered", () => {
  const state = questionStateFrom(dialogFor("the review screen with a question unanswered"));

  expect(state.review).toBe(true);
  expect(state.question).toBeNull();
  expect(state.tabs.every((tab) => !tab.answered)).toBe(true);
});

test("a two-column question's Notes field is what a panel reads as its free text", () => {
  const state = questionStateFrom(dialogFor("a two-column question answered, with a note"));

  expect(state.options.map((option) => `${option.label}:${option.marked}`))
    .toEqual(["A short one:false", "A deliberately very:true"]);
  // There is no free-text ROW on this shape. A panel that kept looking for one would read the last
  // option as the field, showing one option fewer than the question has and the wrong text beside.
  expect(state.other).toBe("combo note");
});

test("an unopened Notes field is Claude's own prompt rather than somebody's words", () => {
  const state = questionStateFrom(dialogFor("a two-column question, nothing answered"));

  expect(state.other).toBeNull();
  expect(state.options.map((option) => option.label)).toEqual(["Iron", "Tin"]);
});
