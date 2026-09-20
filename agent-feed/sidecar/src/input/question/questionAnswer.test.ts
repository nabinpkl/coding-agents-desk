import { expect, test } from "bun:test";
import type { TmuxQuestionAnswer } from "@agentdesk/agent-feed-wire";
import { answerTmuxQuestion, type QuestionRuntime } from "@/input/question/questionAnswer";
import { questionDialog } from "@/input/question/questionDialog";
import { QuestionPane, type PaneQuestion } from "@/input/question/questionPane";

/** Every test gets its own session id, because the turn lock this takes is process-wide. */
let nextSession = 0;
function session(): string {
  nextSession += 1;
  return `00000000-0000-0000-0000-${String(nextSession).padStart(12, "0")}`;
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

function answer(question: string, labels: string[], other = ""): TmuxQuestionAnswer {
  return { question, chosen: labels.map((label, index) => ({ index, label })), other };
}

/** Answers naming options by their real index rather than assuming they are the first ones. */
function pick(question: string, picks: [number, string][], other = ""): TmuxQuestionAnswer {
  return { question, chosen: picks.map(([index, label]) => ({ index, label })), other };
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

test("a lone single-select question is answered by one press and closes the dialog", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);
  const outcome = await answerTmuxQuestion(session(), [pick("Which colour?", [[1, "BRAVO"]])], runtime);

  expect(outcome).toEqual({ answered: true });
  expect(pane.closed).toBe("submitted");
  expect(pane.answerFor(0)).toEqual(["BRAVO"]);
  // This shape draws no Submit tab and needs no Enter: the digit alone selects, marks and submits.
  expect(sent).toEqual(["2"]);
});

test("free text on a single-select question is typed and committed with Return", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [{ question: "Which colour?", chosen: [], other: "a colour of my own" }],
    runtime,
  );

  expect(outcome).toEqual({ answered: true });
  expect(pane.answerFor(0)).toEqual(["a colour of my own"]);
});

test("a multi-select question ticks what was asked for and leaves by its own button", async () => {
  const pane = new QuestionPane([TOPPINGS]);
  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [pick("Which toppings?", [[0, "DELTA"], [2, "FOXTROT"]])],
    runtime,
  );

  expect(outcome).toEqual({ answered: true });
  expect(pane.closed).toBe("submitted");
  expect(pane.answerFor(0)).toEqual(["DELTA", "FOXTROT"]);
});

test("a multi-select question carries its free text alongside its ticks", async () => {
  const pane = new QuestionPane([TOPPINGS]);
  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [pick("Which toppings?", [[1, "ECHO"]], "and something else")],
    runtime,
  );

  expect(outcome).toEqual({ answered: true });
  expect(pane.answerFor(0)).toEqual(["ECHO", "and something else"]);
});

test("three questions of mixed shape are all answered, then submitted once", async () => {
  const pane = new QuestionPane([
    { header: "One", question: "Pick one?", multiSelect: false, options: ["AAA", "BBB"] },
    TOPPINGS,
    { header: "Three", question: "Pick last?", multiSelect: false, options: ["FFF", "GGG"] },
  ]);
  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(session(), [
    pick("Pick one?", [[1, "BBB"]]),
    pick("Which toppings?", [[0, "DELTA"]], "plus a note"),
    { question: "Pick last?", chosen: [], other: "neither, actually" },
  ], runtime);

  expect(outcome).toEqual({ answered: true });
  expect(pane.closed).toBe("submitted");
  expect(pane.answerFor(0)).toEqual(["BBB"]);
  expect(pane.answerFor(1)).toEqual(["DELTA", "plus a note"]);
  expect(pane.answerFor(2)).toEqual(["neither, actually"]);
});

test("a tick somebody else made that was not asked for is taken back off", async () => {
  const pane = new QuestionPane([TOPPINGS]);
  // Somebody at the keyboard ticked ECHO before the panel's answers arrived.
  pane.send(new TextEncoder().encode("2"));
  expect(pane.answerFor(0)).toEqual(["ECHO"]);

  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [pick("Which toppings?", [[0, "DELTA"]])],
    runtime,
  );

  expect(outcome).toEqual({ answered: true });
  // Reconciled rather than added to: a blind press per wanted option would have left ECHO on.
  expect(pane.answerFor(0)).toEqual(["DELTA"]);
});

test("an option whose row says something else is refused before any key is sent", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [pick("Which colour?", [[1, "NOT WHAT THE ROW SAYS"]], "words I typed")],
    runtime,
  );

  expect(outcome.answered).toBe(false);
  expect(outcome).toMatchObject({ reason: "wrong-option" });
  expect(sent).toEqual([]);
  expect(pane.closed).toBeNull();
});

test("a dialog with a different number of questions is refused rather than pressed through", async () => {
  const pane = new QuestionPane([COLOUR, TOPPINGS]);
  const { runtime, sent } = driving(pane);
  const outcome = await answerTmuxQuestion(session(), [answer("Which colour?", ["ALPHA"])], runtime);

  expect(outcome).toMatchObject({ answered: false, reason: "wrong-dialog" });
  expect(sent).toEqual([]);
});

test("a pane showing no dialog is refused, not typed into", async () => {
  const pane = new QuestionPane([COLOUR]);
  pane.closed = "submitted";
  const { runtime, sent } = driving(pane);
  const outcome = await answerTmuxQuestion(session(), [answer("Which colour?", ["ALPHA"])], runtime);

  expect(outcome).toMatchObject({ answered: false, reason: "no-dialog" });
  expect(sent).toEqual([]);
});

test("a session with no pane is refused", async () => {
  const { runtime } = driving(new QuestionPane([COLOUR]));
  const outcome = await answerTmuxQuestion(
    session(),
    [answer("Which colour?", ["ALPHA"])],
    { ...runtime, pane: async () => null },
  );
  expect(outcome).toMatchObject({ answered: false, reason: "no-pane" });
});

test("every refusal hands back the words the reader typed", async () => {
  const pane = new QuestionPane([COLOUR, TOPPINGS]);
  const { runtime } = driving(pane);
  // One question short, so this refuses before pressing anything -- which is exactly the moment
  // the typed text would otherwise exist nowhere but in a request that already failed.
  const outcome = await answerTmuxQuestion(session(), [
    { question: "Which colour?", chosen: [], other: "the sentence I wrote" },
  ], runtime);

  expect(outcome).toEqual({
    answered: false,
    reason: "wrong-dialog",
    sent: false,
    keptText: [{ question: "Which colour?", text: "the sentence I wrote" }],
  });
});

test("a screen this cannot read is a refusal, never a question reported as answered", async () => {
  // The hazard `dialogGone` exists for. "No dialog here" is what an unreadable screen says too,
  // and the caller reads it as the dialog having closed -- so a pane showing anything this module
  // does not recognise used to come back as a successful answer nobody had given.
  const pane = new QuestionPane([COLOUR]);
  const { runtime } = driving(pane);
  let reads = 0;
  const garbled: QuestionRuntime = {
    ...runtime,
    // A pane mid-repaint: never the same twice, and never a dialog.
    screen: async () => ({ screen: `partway through a repaint ${reads += 1}`, cursor: { row: 0, column: 0 } }),
  };
  const outcome = await answerTmuxQuestion(
    session(),
    [pick("Which colour?", [[0, "ALPHA"]])],
    garbled,
  );

  expect(outcome).toMatchObject({ answered: false, reason: "no-dialog", sent: false });
});

test("a refusal after keys have gone out says so, rather than that nothing was sent", async () => {
  // Two questions, and the second one disappears under the driver after the first is answered.
  // The first question's press has landed in the terminal by then, and the reader has to be told.
  const pane = new QuestionPane([COLOUR, TOPPINGS]);
  const { runtime } = driving(pane);
  let answeredFirst = false;
  const vanishing: QuestionRuntime = {
    ...runtime,
    screen: async () => {
      const screen = pane.screen();
      // Once the first question is answered the pane starts reporting a screen with no dialog on
      // it, which is what somebody cancelling it at the keyboard would produce.
      if (answeredFirst) return { screen: "the dialog has gone", cursor: { row: 0, column: 0 } };
      return { screen, cursor: { row: 0, column: 0 } };
    },
    send: async (target, bytes) => {
      await runtime.send(target, bytes);
      if (pane.answerFor(0).length > 0) answeredFirst = true;
    },
  };
  const outcome = await answerTmuxQuestion(session(), [
    pick("Which colour?", [[0, "ALPHA"]]),
    pick("Which toppings?", [[0, "DELTA"]]),
  ], vanishing);

  expect(outcome.answered).toBe(false);
  expect(outcome).toMatchObject({ sent: true });
});

test("Escape is never sent, because it would destroy the dialog and the typed text with it", async () => {
  // A pane that refuses to redraw: every press is a stall, which is the failure most likely to
  // tempt an abort. The rewind picker escapes on its way out; this must not, and the dialog has to
  // still be standing afterwards for somebody to finish at the keyboard.
  const pane = new QuestionPane([COLOUR, TOPPINGS]);
  const { runtime, sent } = driving(pane);
  const frozen: QuestionRuntime = { ...runtime, send: async () => {} };
  const outcome = await answerTmuxQuestion(session(), [
    pick("Which colour?", [[0, "ALPHA"]]),
    pick("Which toppings?", [[0, "DELTA"]], "and this text"),
  ], frozen);

  expect(outcome.answered).toBe(false);
  expect(sent).toEqual([]);
  expect(pane.closed).toBeNull();
  expect(questionDialog({ screen: pane.screen(), cursor: { row: 0, column: 0 } })).not.toBeNull();
});

test("an escape inside somebody's typed answer arrives as a character, not as a key", async () => {
  const pane = new QuestionPane([COLOUR]);
  const { runtime, sent } = driving(pane);
  await answerTmuxQuestion(
    session(),
    [{ question: "Which colour?", chosen: [], other: "beforeafter" }],
    runtime,
  );

  expect(sent.join("")).not.toContain("[");
  expect(sent.some((keys) => keys.includes("␛"))).toBe(true);
  expect(pane.answerFor(0)).toEqual(["before␛after"]);
});

test("free text replaces what the row already holds rather than being appended to it", async () => {
  const pane = new QuestionPane([COLOUR]);
  // Somebody started typing in the pane and stopped.
  pane.send(new TextEncoder().encode("4half a thought"));
  const { runtime } = driving(pane);
  const outcome = await answerTmuxQuestion(
    session(),
    [{ question: "Which colour?", chosen: [], other: "the whole thought" }],
    runtime,
  );

  expect(outcome).toEqual({ answered: true });
  expect(pane.answerFor(0)).toEqual(["the whole thought"]);
});
