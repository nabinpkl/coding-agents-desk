import { describe, expect, it } from "vitest";
import type { AskUserQuestionItem } from "@/app/askUserQuestion";
import type { TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import {
  adoptPaneState,
  alignDrafts,
  chooseOption,
  emptyDrafts,
  isAnswered,
  paneCursorFrom,
  paneQuestionAt,
  sameLabel,
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

/** What the pane reports for a dialog showing the single-select question above. */
function showing(overrides: Partial<TmuxQuestionState> = {}): TmuxQuestionState {
  return {
    question: "Which colour?",
    prompt: "Which colour?",
    review: false,
    multiSelect: false,
    tabs: [{ label: "Colour", answered: false }],
    options: [
      { label: "ALPHA", detail: "", marked: false, cursor: true },
      { label: "BRAVO", detail: "", marked: false, cursor: false },
      { label: "CHARLIE", detail: "", marked: false, cursor: false },
    ],
    other: null,
    ...overrides,
  };
}

describe("reading a label off a screen", () => {
  it("matches on the start, because a long one wraps rather than truncating", () => {
    // The screen gives back as much of the label as fitted on its row, and the rest is on a line
    // indented exactly like a description -- indistinguishable from one, so unrecoverable.
    expect(sameLabel("ALPHA a deliberately very long option", "ALPHA a deliberately very long option label")).toBe(
      true,
    );
    expect(sameLabel("ALPHA", "ALPHA")).toBe(true);
    expect(sameLabel("BRAVO", "ALPHA")).toBe(false);
    // A blank row names nothing, and matching it against everything would answer whatever was
    // first in the list.
    expect(sameLabel("   ", "ALPHA")).toBe(false);
  });
});

describe("following what the terminal already holds", () => {
  it("fills a question nobody has answered here", () => {
    const drafts = emptyDrafts([SINGLE]);
    const next = adoptPaneState(
      drafts,
      [SINGLE],
      showing({
        options: [
          { label: "ALPHA", detail: "", marked: false, cursor: false },
          { label: "BRAVO", detail: "", marked: true, cursor: false },
          { label: "CHARLIE", detail: "", marked: false, cursor: true },
        ],
      }),
      () => true,
    );

    // Somebody answered this at the keyboard before the panel was opened on it. Drawing an empty
    // draft over the top would invite this reader to redo work that is already done.
    expect(next[0]).toEqual({ chosen: [1], other: "" });
  });

  it("never overwrites an answer this reader has not sent yet", () => {
    const drafts = chooseOption(emptyDrafts([SINGLE]), 0, 2, false);
    const next = adoptPaneState(
      drafts,
      [SINGLE],
      showing({
        options: [
          { label: "ALPHA", detail: "", marked: true, cursor: false },
          { label: "BRAVO", detail: "", marked: false, cursor: false },
          { label: "CHARLIE", detail: "", marked: false, cursor: false },
        ],
      }),
      () => false,
    );

    // A draft is newer than any screen: the whole point of drafting here is that a tap is not
    // committed until Submit, so a reading must not take it back.
    expect(next[0]).toEqual({ chosen: [2], other: "" });
  });

  it("takes the words in the free-text row, and ignores Claude's own prompt", () => {
    const withText = adoptPaneState(
      emptyDrafts([SINGLE]),
      [SINGLE],
      showing({
        other: "a colour of my own",
      }),
      () => true,
    );
    expect(withText[0]).toEqual({ chosen: [], other: "a colour of my own" });

    // A dialog nobody has touched says nothing this side does not already know, and adopting it
    // every reading would clear the draft continuously.
    const untouched = adoptPaneState(emptyDrafts([SINGLE]), [SINGLE], showing(), () => true);
    expect(untouched[0]).toEqual({ chosen: [], other: "" });
  });

  it("leaves everything alone on the review screen, which reports no question", () => {
    const drafts = emptyDrafts([SINGLE]);
    expect(adoptPaneState(drafts, [SINGLE], showing({ question: null, review: true }), () => true)).toEqual(drafts);
  });
});

describe("where the terminal's own cursor is", () => {
  it("answers in the tool call's own indices, not the screen's", () => {
    expect(paneCursorFrom([SINGLE], showing())).toEqual({ at: 0, option: 0 });
    expect(
      paneCursorFrom(
        [SINGLE],
        showing({
          options: [
            { label: "ALPHA", detail: "", marked: false, cursor: false },
            { label: "BRAVO", detail: "", marked: false, cursor: false },
            { label: "CHARLIE", detail: "", marked: false, cursor: true },
          ],
        }),
      ),
    ).toEqual({ at: 0, option: 2 });
  });

  it("keeps the cursor and the answer apart when the pane has them on different rows", () => {
    // The case the whole separation exists for, and the shape the terminal actually draws: an
    // answered single-select question marks the chosen row with a trailing tick and leaves the
    // cursor back where it was. Folding the two together would move this reader's answer to
    // whatever row somebody last walked past.
    const pane = showing({
      options: [
        { label: "ALPHA", detail: "", marked: false, cursor: true },
        { label: "BRAVO", detail: "", marked: true, cursor: false },
        { label: "CHARLIE", detail: "", marked: false, cursor: false },
      ],
    });

    expect(adoptPaneState(emptyDrafts([SINGLE]), [SINGLE], pane, () => true)[0]).toEqual({ chosen: [1], other: "" });
    expect(paneCursorFrom([SINGLE], pane)).toEqual({ at: 0, option: 0 });
  });

  it("has no answer when the cursor is not on an option at all", () => {
    // A cursor parked in the free-text row or on a multi-select question's inline button: neither
    // is an option, and `TmuxQuestionState` has already dropped both, so no option carries it.
    expect(
      paneCursorFrom(
        [SINGLE],
        showing({
          options: [
            { label: "ALPHA", detail: "", marked: false, cursor: false },
            { label: "BRAVO", detail: "", marked: false, cursor: false },
            { label: "CHARLIE", detail: "", marked: false, cursor: false },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("says nothing rather than guessing at a row it cannot match", () => {
    // A ring drawn on a guess is indistinguishable from one drawn on a reading.
    expect(
      paneCursorFrom(
        [SINGLE],
        showing({
          options: [{ label: "ZULU", detail: "", marked: false, cursor: true }],
        }),
      ),
    ).toBeNull();
    expect(paneCursorFrom([SINGLE], showing({ question: null, review: true }))).toBeNull();
    expect(paneCursorFrom([SINGLE], null)).toBeNull();
  });
});

describe("which question the terminal is on", () => {
  it("answers even when the cursor is nowhere near an option", () => {
    // The case that made the mirror look completely dead. A multi-select question parks the cursor
    // on its inline Submit button or its free-text row, neither of which is an option, so nothing
    // reports a cursor -- while the pane is plainly still on that question.
    const pane = {
      question: "Which toppings?",
      prompt: "Which toppings?",
      review: false,
      multiSelect: true,
      tabs: [
        { label: "Colour", answered: true },
        { label: "Toppings", answered: false },
      ],
      options: [
        { label: "DELTA", detail: "", marked: false, cursor: false },
        { label: "ECHO", detail: "", marked: false, cursor: false },
      ],
      other: null,
    };

    expect(paneCursorFrom([SINGLE, MANY], pane)).toBeNull();
    expect(paneQuestionAt([SINGLE, MANY], pane)).toBe(1);
  });

  it("has no answer for a review screen or a question this call does not carry", () => {
    expect(paneQuestionAt([SINGLE], showing({ question: null, review: true }))).toBeNull();
    expect(paneQuestionAt([SINGLE], showing({ question: "Something else entirely?" }))).toBeNull();
    expect(paneQuestionAt([SINGLE], null)).toBeNull();
  });
});
