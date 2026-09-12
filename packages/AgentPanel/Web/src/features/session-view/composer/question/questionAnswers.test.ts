import { describe, expect, it } from "vitest";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import {
  alignDrafts,
  chooseOption,
  emptyDrafts,
  isAnswered,
  toAnswers,
  writeOther,
} from "@/features/session-view/composer/question/questionAnswers";

const SINGLE: AskUserQuestionItem = {
  question: "Which colour?",
  header: "Colour",
  multiSelect: false,
  options: [{ label: "ALPHA" }, { label: "BRAVO" }, { label: "CHARLIE" }],
};
const MANY: AskUserQuestionItem = {
  question: "Which toppings?",
  header: "Toppings",
  multiSelect: true,
  options: [{ label: "DELTA" }, { label: "ECHO" }],
};

describe("chooseOption", () => {
  it("replaces the pick on a single-select question", () => {
    let drafts = emptyDrafts([SINGLE]);
    drafts = chooseOption(drafts, 0, 2, false);
    drafts = chooseOption(drafts, 0, 0, false);
    expect(drafts[0]!.chosen).toEqual([0]);
  });

  it("unpicks when the same single-select option is chosen again", () => {
    let drafts = chooseOption(emptyDrafts([SINGLE]), 0, 1, false);
    drafts = chooseOption(drafts, 0, 1, false);
    expect(drafts[0]!.chosen).toEqual([]);
  });

  it("accumulates on a multi-select question, in the order they were picked", () => {
    let drafts = emptyDrafts([MANY]);
    drafts = chooseOption(drafts, 0, 1, true);
    drafts = chooseOption(drafts, 0, 0, true);
    // The dialog reports its answers in pick order, so the review reads the same either way.
    expect(drafts[0]!.chosen).toEqual([1, 0]);
    expect(drafts[0]!.chosen).not.toEqual([0, 1]);
  });

  it("touches only the question it names", () => {
    let drafts = emptyDrafts([SINGLE, MANY]);
    drafts = chooseOption(drafts, 1, 0, true);
    expect(drafts[0]!.chosen).toEqual([]);
    expect(drafts[1]!.chosen).toEqual([0]);
  });
});

describe("free text and options as alternatives", () => {
  it("picking an option on a single-select question clears its text", () => {
    let drafts = writeOther(emptyDrafts([SINGLE]), 0, "something of my own", false);
    drafts = chooseOption(drafts, 0, 1, false);
    // One answer per question here, and a request carrying both is refused by the sidecar as a
    // contradiction rather than resolved by it picking one.
    expect(drafts[0]).toEqual({ chosen: [1], other: "" });
  });

  it("typing on a single-select question clears its pick", () => {
    let drafts = chooseOption(emptyDrafts([SINGLE]), 0, 1, false);
    drafts = writeOther(drafts, 0, "actually, none of those", false);
    expect(drafts[0]).toEqual({ chosen: [], other: "actually, none of those" });
  });

  it("a multi-select question keeps both, because the dialog carries both", () => {
    let drafts = chooseOption(emptyDrafts([MANY]), 0, 1, true);
    drafts = writeOther(drafts, 0, "and something else", true);
    expect(drafts[0]).toEqual({ chosen: [1], other: "and something else" });
  });

  it("clearing the text on a single-select question leaves the pick alone", () => {
    let drafts = chooseOption(emptyDrafts([SINGLE]), 0, 2, false);
    drafts = writeOther(drafts, 0, "", false);
    expect(drafts[0]).toEqual({ chosen: [2], other: "" });
  });
});

describe("toAnswers", () => {
  it("carries every question with the label its index names", () => {
    let drafts = emptyDrafts([SINGLE, MANY]);
    drafts = chooseOption(drafts, 0, 1, false);
    drafts = chooseOption(drafts, 1, 0, true);
    drafts = writeOther(drafts, 1, "  and a note  ", true);

    expect(toAnswers([SINGLE, MANY], drafts)).toEqual([
      { question: "Which colour?", chosen: [{ index: 1, label: "BRAVO" }], other: "" },
      {
        question: "Which toppings?",
        chosen: [{ index: 0, label: "DELTA" }],
        other: "and a note",
      },
    ]);
  });

  it("is null while any question is unanswered", () => {
    const drafts = chooseOption(emptyDrafts([SINGLE, MANY]), 0, 1, false);
    // A short set would spend the answers that ARE ready on a submit the dialog refuses.
    expect(toAnswers([SINGLE, MANY], drafts)).toBeNull();
  });

  it("is null when the drafts do not describe these questions", () => {
    expect(toAnswers([SINGLE, MANY], emptyDrafts([SINGLE]))).toBeNull();
  });

  it("counts whitespace-only text as no answer", () => {
    const drafts = writeOther(emptyDrafts([SINGLE]), 0, "   ", false);
    expect(isAnswered(drafts[0]!)).toBe(false);
    expect(toAnswers([SINGLE], drafts)).toBeNull();
  });

  it("grows to a question that arrived late without losing the answers already given", () => {
    // A tool call's input streams into the transcript, so a draft can be built while the panel
    // holds only some of the questions. Measured on a live pane: it stayed short, and every click
    // on the last question was dropped by the write.
    const answered = chooseOption(emptyDrafts([SINGLE]), 0, 1, false);
    const grown = alignDrafts(answered, 2);
    expect(grown).toHaveLength(2);
    expect(grown[0]!.chosen).toEqual([1]);
    expect(isAnswered(grown[1]!)).toBe(false);
    // And a write to the question that arrived late now lands.
    expect(chooseOption(grown, 1, 0, true)[1]!.chosen).toEqual([0]);
  });

  it("drops drafts for questions that are no longer there", () => {
    expect(alignDrafts(emptyDrafts([SINGLE, MANY]), 1)).toHaveLength(1);
  });
});
