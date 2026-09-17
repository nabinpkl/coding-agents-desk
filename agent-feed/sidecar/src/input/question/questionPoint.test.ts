/**
 * The cursor driver, tested for what it must NOT do as much as for what it does.
 *
 * Driven against `QuestionPane`, the same stand-in the answerer's suite uses, so these are checks
 * against the measured behaviour of the real dialog rather than against a mock written to agree.
 */
import { expect, test } from "bun:test";
import { pointTmuxQuestion } from "@/input/question/questionPoint";
import { DOWN, LEFT, RIGHT, UP, type QuestionRuntime } from "@/input/question/questionKeys";
import { QuestionPane, type PaneQuestion } from "@/input/question/questionPane";

/** Every test gets its own session id, because the turn lock this takes is process-wide. */
let nextSession = 0;
function session(): string {
  nextSession += 1;
  return `00000000-0000-0000-0000-1${String(nextSession).padStart(11, "0")}`;
}

function driving(pane: QuestionPane): { runtime: QuestionRuntime; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    runtime: {
      pane: async () => "a-pane",
      screen: async () => ({ screen: pane.screen(), cursor: { row: 0, column: 0 } }),
      send: async (_target, bytes) => {
        sent.push(new TextDecoder().decode(bytes));
        pane.send(bytes);
      },
      redrawLimitMs: 0,
      wait: async () => {},
    },
  };
}

const COLOUR: PaneQuestion = {
  header: "Colour",
  question: "Which colour?",
  multiSelect: false,
  options: ["ALPHA", "BRAVO", "CHARLIE"],
};
const TOPPINGS: PaneQuestion = {
  header: "Toppings",
  question: "Which toppings?",
  multiSelect: true,
  options: ["DELTA", "ECHO", "FOXTROT"],
};

/** The four keys this driver is allowed to press, and the whole point of the module. */
const ARROWS = new Set([UP, DOWN, LEFT, RIGHT]);

test("puts the cursor on an option using only arrows, answering nothing", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?"], at: 0, option: 2, label: "CHARLIE" },
    runtime,
  );

  expect(outcome).toEqual({ pointed: true });
  expect(pane.cursor).toBe(2);
  // The load-bearing assertion. A digit here would have selected CHARLIE, marked the tab answered
  // and submitted the dialog in one press, because this question is the only one in the call.
  expect(sent.every((keys) => ARROWS.has(keys))).toBe(true);
  expect(pane.answered).toEqual([false]);
  expect(pane.closed).toBeNull();
  expect(pane.answerFor(0)).toEqual([]);
});

test("walks back up the rows as readily as down them", async () => {
  const pane = new QuestionPane([COLOUR]);
  pane.cursor = 2;
  const { runtime, sent } = driving(pane);

  await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?"], at: 0, option: 0, label: "ALPHA" },
    runtime,
  );

  expect(pane.cursor).toBe(0);
  expect(sent).toEqual([UP, UP]);
});

test("steps between questions to reach one the pane is not showing", async () => {
  const pane = new QuestionPane([COLOUR, TOPPINGS]);
  const { runtime, sent } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?", "Which toppings?"], at: 1, option: 1, label: "ECHO" },
    runtime,
  );

  expect(outcome).toEqual({ pointed: true });
  expect(pane.tab).toBe(1);
  expect(pane.cursor).toBe(1);
  // A tab step is a side arrow and moves nothing else; neither question ends up answered by it.
  expect(sent[0]).toBe(RIGHT);
  expect(sent.every((keys) => ARROWS.has(keys))).toBe(true);
  expect(pane.answered).toEqual([false, false]);
});

test("ticks nothing on a multi-select question it points at", async () => {
  const pane = new QuestionPane([TOPPINGS]);
  const { runtime } = driving(pane);

  await pointTmuxQuestion(
    session(),
    { questions: ["Which toppings?"], at: 0, option: 2, label: "FOXTROT" },
    runtime,
  );

  expect(pane.cursor).toBe(2);
  // The cursor is on FOXTROT and its box is still empty, which is the difference between looking
  // at an option and choosing it. A digit here would have ticked it.
  expect([...pane.ticked[0]!]).toEqual([]);
  expect(pane.answerFor(0)).toEqual([]);
});

test("refuses a label the row does not say, without pressing anything", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?"], at: 0, option: 1, label: "DELTA" },
    runtime,
  );

  // Position picks the row and text decides whether to move to it. A mirror that pointed at the
  // wrong row anyway would be worse than one that is briefly out of step.
  expect(outcome).toEqual({ pointed: false, reason: "wrong-option" });
  expect(sent).toEqual([]);
  expect(pane.cursor).toBe(0);
});

test("refuses a dialog holding a different number of questions", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?", "Which toppings?"], at: 0, option: 0, label: "ALPHA" },
    runtime,
  );

  expect(outcome).toEqual({ pointed: false, reason: "wrong-dialog" });
  expect(sent).toEqual([]);
});

test("refuses once the dialog has gone rather than pressing into a composer", async () => {
  const pane = new QuestionPane([COLOUR]);
  pane.closed = "submitted";
  const { runtime, sent } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?"], at: 0, option: 0, label: "ALPHA" },
    runtime,
  );

  expect(outcome).toEqual({ pointed: false, reason: "no-dialog" });
  expect(sent).toEqual([]);
});

test("refuses a session with no pane", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime } = driving(pane);

  const outcome = await pointTmuxQuestion(
    session(),
    { questions: ["Which colour?"], at: 0, option: 0, label: "ALPHA" },
    { ...runtime, pane: async () => null },
  );

  expect(outcome).toEqual({ pointed: false, reason: "no-pane" });
});
