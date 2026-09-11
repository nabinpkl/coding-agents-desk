/**
 * The tmux half of the AskUserQuestion mirror: drafting every answer, then committing once.
 *
 * Mounted directly rather than through the app harness, which has no way to put a session on a
 * tmux band. What is being tested is the contract between the surface and the one request it
 * makes, and that is the whole of it.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { TmuxQuestionAnswer, TmuxQuestionOutcome } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";
import { AskUserQuestionMirror } from "@/features/session-view/composer/AskUserQuestionMirror";
import { useTmuxQuestion } from "@/features/session-view/composer/useTmuxQuestion";

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
  { question, answer }: { question: OpenAskUserQuestion; answer: Answer },
) {
  const model = useTmuxQuestion({ answerTmuxQuestion: answer }, SESSION, question);
  return (
    <AskUserQuestionMirror
      questions={model.questions}
      drafts={model.drafts}
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

describe("the tmux question mirror", () => {
  it("draws every question of the call, with its previews", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    expect(screen.getByText("Which colour?")).toBeInTheDocument();
    expect(screen.getByText("Which toppings?")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    // The terminal shows one preview at a time and wraps long labels; this surface has the JSON.
    // Matched without normalising whitespace, because the newline is the content: a preview is a
    // small diagram, and a reflowed one shows something else.
    expect(screen.getByText((_, node) => node?.tagName === "PRE" && node.textContent === "a | b\nc | d"))
      .toBeInTheDocument();
    expect(screen.getByText("The first one.")).toBeInTheDocument();
    // Single-select draws radios, multi-select checkboxes, each with its own free-text row.
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
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
    fireEvent.click(screen.getByRole("checkbox", { name: "ECHO" }));
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "and a note" } });
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

  it("keeps both on a multi-select question, because the dialog carries both", () => {
    render(<Mirror question={CALL} answer={async () => ({ answered: true })} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "DELTA" }));
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "plus this" } });
    expect(screen.getByRole("checkbox", { name: "DELTA" })).toBeChecked();
    expect(screen.getByLabelText(OTHER_TOPPINGS)).toHaveValue("plus this");
  });

  it("a refusal leaves the typed words in the field they were written in", async () => {
    const answer = vi.fn<Answer>(async (_session, answers) => ({
      answered: false,
      reason: "no-dialog",
      keptText: answers
        .filter((entry) => entry.other.length > 0)
        .map((entry) => ({ question: entry.question, text: entry.other })),
    }));
    render(<Mirror question={CALL} answer={answer} />);

    fireEvent.change(screen.getByLabelText(OTHER_COLOUR), { target: { value: "a long sentence" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "DELTA" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    // The failure this whole shape exists to prevent: the reason is on screen AND the words are
    // still where they were typed, so nothing has to be rewritten to try again.
    expect(screen.getByLabelText("Claude question")).toHaveTextContent("no longer open");
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("a long sentence");
    expect(screen.getByRole("checkbox", { name: "DELTA" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
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
    fireEvent.change(screen.getByLabelText(OTHER_TOPPINGS), { target: { value: "my other" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });

    expect(screen.getByLabelText("Claude question")).toHaveTextContent("the sidecar went away");
    expect(screen.getByLabelText(OTHER_COLOUR)).toHaveValue("my answer");
    expect(screen.getByLabelText(OTHER_TOPPINGS)).toHaveValue("my other");
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
