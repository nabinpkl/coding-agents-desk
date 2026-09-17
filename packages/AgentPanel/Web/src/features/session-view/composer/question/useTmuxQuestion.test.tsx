/**
 * The tmux half of the AskUserQuestion mirror: drafting every answer, then committing once.
 *
 * Mounted directly rather than through the app harness, which has no way to put a session on a
 * tmux band. What is being tested is the contract between the surface and the one request it
 * makes, and that is the whole of it.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type {
  TmuxQuestionAnswer,
  TmuxQuestionOutcome,
  TmuxQuestionPoint,
  TmuxQuestionPointOutcome,
  TmuxQuestionState,
} from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";
import { AskUserQuestionMirror } from "@/features/session-view/composer/question/AskUserQuestionMirror";
import { useTmuxQuestion } from "@/features/session-view/composer/question/useTmuxQuestion";

const SESSION: SessionAddress = { source: "claude", sessionId: "sid-claude-01" };

/** The one call the hook makes, spelled out so a mock's arguments are typed rather than inferred. */
type Answer = (
  session: SessionAddress,
  answers: readonly TmuxQuestionAnswer[],
) => Promise<TmuxQuestionOutcome>;

const CALL: OpenAskUserQuestion = {
  callId: "toolu_01",
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      multiSelect: false,
      options: [
        { label: "ALPHA", description: "The first one." },
        { label: "BRAVO", preview: "a | b\nc | d" },
      ],
    },
    {
      question: "Which toppings?",
      header: "Toppings",
      multiSelect: true,
      options: [{ label: "DELTA" }, { label: "ECHO" }],
    },
  ],
};

function Mirror(
  { question, answer, point, pane }: {
    question: OpenAskUserQuestion;
    answer: Answer;
    /** Where the surface asked the terminal to put its cursor, when a test is watching for it. */
    point?: (session: SessionAddress, wanted: TmuxQuestionPoint) => Promise<TmuxQuestionPointOutcome>;
    /** What the session's own terminal is showing, once anything is watching it. */
    pane?: TmuxQuestionState | null;
  },
) {
  const model = useTmuxQuestion(
    { answerTmuxQuestion: answer, pointTmuxQuestion: point ?? (async () => ({ pointed: true })) },
    SESSION,
    question,
    pane ?? null,
  );
  return (
    <AskUserQuestionMirror
      questions={model.questions}
      drafts={model.drafts}
      paneCursor={model.paneCursor}
      paneAt={model.paneAt}
      onPoint={model.point}
      pending={model.pending}
      disabled={false}
      error={model.error}
      notice={null}
      canSubmit={model.canSubmit}
      onChoose={model.choose}
      onWriteOther={model.write}
      onSubmit={() => void model.submit()}
    />
  );
}

const OTHER_COLOUR = "Your own answer to: Which colour?";
const OTHER_TOPPINGS = "Your own answer to: Which toppings?";

/** Moves to the next question, the way a reader does. */
function next() {
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
}

function previous() {
  fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
}

describe("the tmux question mirror", () => {
  it("draws one question at a time, and pages between them", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    // The band is above the transcript and does not scroll, so a call's questions are paged
    // rather than stacked: the second one is reachable, not drawn.
    expect(screen.getByText("Which colour?")).toBeInTheDocument();
    expect(screen.queryByText("Which toppings?")).toBeNull();
    // Single-select draws radios, and the free-text row is one of them.
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // The terminal shows one preview at a time and wraps long labels; this surface has the JSON.
    // Matched without normalising whitespace, because the newline is the content: a preview is a
    // small diagram, and a reflowed one shows something else.
    expect(screen.getByText((_, node) => node?.tagName === "PRE" && node.textContent === "a | b\nc | d"))
      .toBeInTheDocument();
    expect(screen.getByText("The first one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();

    next();
    expect(screen.queryByText("Which colour?")).toBeNull();
    expect(screen.getByText("Which toppings?")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();

    previous();
    expect(screen.getByText("Which colour?")).toBeInTheDocument();
  });

  it("names every question in a strip, so one can be reached without stepping", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    const toppings = screen.getByRole("button", {
      name: "Question 2 of 2: Which toppings?",
    });
    fireEvent.click(toppings);
    expect(screen.getByText("Which toppings?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Question 1 of 2: Which colour?" }));
    expect(screen.getByText("Which colour?")).toBeInTheDocument();
  });

  it("keeps its own scrolling to itself, so the transcript behind does not move", () => {
    const { container } = render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    // Asserted on the class rather than on layout, which jsdom does not compute. The pair is the
    // whole of the fix: a height the question cannot exceed, and no scroll chaining out of it.
    const scroller = container.querySelector(".overscroll-contain");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("overflow-y-auto");
    expect(scroller!.className).toContain("max-h-");
  });

  it("will not submit until every question has an answer, and says how many are left", () => {
    const answer = vi.fn<Answer>(async () => ({ answered: true }));
    render(<Mirror question={CALL} answer={answer} />);

    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
    expect(screen.getByText("2 of 2 still to answer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));
    expect(screen.getByText("1 of 2 still to answer")).toBeInTheDocument();
    // A short set would spend the answer that IS ready on a submit the dialog refuses.
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  });

  it("sends every answer in one request, each with the label its index names", async () => {
    const answer = vi.fn<Answer>(async () => ({ answered: true }));
    render(<Mirror question={CALL} answer={answer} />);

    fireEvent.click(screen.getByRole("radio", { name: "BRAVO" }));
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "ECHO" }));
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "and a note" } });
    expect(screen.getByText("All answered")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]![1]).toEqual([
      { question: "Which colour?", chosen: [{ index: 1, label: "BRAVO" }], other: "" },
      {
        question: "Which toppings?",
        chosen: [{ index: 1, label: "ECHO" }],
        other: "and a note",
      },
    ]);
  });

  it("keeps an option and free text as alternatives on a single-select question", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));
    fireEvent.change(screen.getByLabelText(OTHER_COLOUR), { target: { value: "neither" } });
    // The dialog takes one answer per question here, so typing clears the pick rather than
    // sending a request the sidecar refuses as a contradiction.
    expect(screen.getByRole("radio", { name: "ALPHA" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("");
  });

  it("picking the free-text row lets go of the option it replaces", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));
    // The row is a move to the field, not a value: it drops the option rather than sitting there
    // as a control that reports checked and does nothing.
    fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
    expect(screen.getByRole("radio", { name: "ALPHA" })).not.toBeChecked();
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveFocus();
  });

  it("keeps both on a multi-select question, because the dialog carries both", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "DELTA" }));
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "plus this" } });
    expect(screen.getByRole("checkbox", { name: "DELTA" })).toBeChecked();
    expect(screen.getByLabelText(OTHER_TOPPINGS)).toHaveValue("plus this");
  });

  it("a refusal leaves the typed words in the field they were written in", async () => {
    const answer = vi.fn<Answer>(async (_session, answers) => ({
      answered: false,
      reason: "no-dialog",
      sent: false,
      keptText: answers
        .filter((entry) => entry.other.length > 0)
        .map((entry) => ({ question: entry.question, text: entry.other })),
    }));
    render(<Mirror question={CALL} answer={answer} />);

    fireEvent.change(screen.getByLabelText(OTHER_COLOUR), { target: { value: "a long sentence" } });
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "DELTA" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    // The failure this whole shape exists to prevent: the reason is on screen AND the words are
    // still where they were typed, so nothing has to be rewritten to try again.
    // What was observed, with no guess about why. The sentence this replaced offered "it may have
    // been answered there", which was wrong both times a reader actually hit it.
    expect(screen.getByLabelText("Claude question"))
      .toHaveTextContent("the terminal is not showing this question, so nothing was sent");
    expect(screen.getByRole("checkbox", { name: "DELTA" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    previous();
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("a long sentence");
  });

  it("a request that throws is reported without taking the draft with it", async () => {
    render(
      <Mirror
        question={CALL}
        answer={async () => {
          throw new Error("the sidecar went away");
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(OTHER_COLOUR), { target: { value: "my answer" } });
    next();
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "my other" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    expect(screen.getByLabelText("Claude question")).toHaveTextContent("the sidecar went away");
    expect(screen.getByLabelText(OTHER_TOPPINGS)).toHaveValue("my other");
    previous();
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("my answer");
  });

  it("says answers may already be in the terminal when keys had gone out", async () => {
    // A refusal is not always a no-op. The driver presses as it walks, so it can give up with a
    // question already answered in the pane -- and the reader has to be told that, not the
    // opposite.
    const answer = vi.fn<Answer>(async () => ({
      answered: false,
      reason: "wrong-dialog",
      sent: true,
      keptText: [],
    }));
    render(<Mirror question={CALL} answer={answer} />);

    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "DELTA" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    expect(screen.getByLabelText("Claude question"))
      .toHaveTextContent("some of these answers may already have landed there");
  });

  it("follows what the terminal already holds, for a question not answered here", async () => {
    // The other direction of the mirror. Somebody may have been part-way through this dialog at
    // the keyboard before the panel was ever opened on it.
    const pane: TmuxQuestionState = {
      question: "Which colour?",
      review: false,
      multiSelect: false,
      tabs: [{ label: "Colour", answered: true }, { label: "Toppings", answered: false }],
      options: [
        { label: "ALPHA", marked: false, cursor: false },
        { label: "BRAVO", marked: true, cursor: true },
      ],
      other: null,
    };
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} pane={pane} />);

    expect(screen.getByRole("radio", { name: "BRAVO" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "ALPHA" })).not.toBeChecked();
  });

  it("does not take back a choice this reader has made and not sent", () => {
    const { rerender } = render(
      <Mirror question={CALL} answer={async () => ({ answered: true })} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "ALPHA" }));

    // The pane then reports the other option, as it would if this reader's answer had not been
    // committed yet and somebody else were moving in the dialog.
    const pane: TmuxQuestionState = {
      question: "Which colour?",
      review: false,
      multiSelect: false,
      tabs: [{ label: "Colour", answered: true }],
      options: [
        { label: "ALPHA", marked: false, cursor: false },
        { label: "BRAVO", marked: true, cursor: true },
      ],
      other: null,
    };
    rerender(<Mirror question={CALL} answer={async () => ({ answered: true })} pane={pane} />);

    // A draft is newer than any screen: nothing is committed until Submit, so a reading must not
    // undo a tap.
    expect(screen.getByRole("radio", { name: "ALPHA" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "BRAVO" })).not.toBeChecked();
  });

  it("starts a fresh draft when a new call arrives", () => {
    const { rerender } = render(
      <Mirror question={CALL} answer={async () => ({ answered: true })} />,
    );
    fireEvent.change(screen.getByLabelText(OTHER_COLOUR), { target: { value: "for the old one" } });

    rerender(
      <Mirror
        question={{ ...CALL, callId: "toolu_02" }}
        answer={async () => ({ answered: true })}
      />,
    );
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("");
  });
});
