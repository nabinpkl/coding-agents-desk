/**
 * The live half of the question mirror: the cursor the terminal is showing, and the cursor the
 * panel asks it to show.
 *
 * Split from `useTmuxQuestion.test.tsx` when that file reached the 500-line cap. The seam is the
 * one the feature already has: that file covers drafting and committing an answer, and this one
 * covers the two surfaces agreeing about where they are looking, which commits nothing.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

const CALL: OpenAskUserQuestion = {
  callId: "toolu_01",
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      multiSelect: false,
      options: [{ label: "ALPHA" }, { label: "BRAVO" }],
    },
    {
      question: "Which toppings?",
      header: "Toppings",
      multiSelect: true,
      options: [{ label: "DELTA" }, { label: "ECHO" }],
    },
  ],
};

function Mirror({
  question,
  answer,
  point,
  pane,
}: {
  question: OpenAskUserQuestion;
  answer: (s: SessionAddress, a: readonly TmuxQuestionAnswer[]) => Promise<TmuxQuestionOutcome>;
  point?: (s: SessionAddress, w: TmuxQuestionPoint) => Promise<TmuxQuestionPointOutcome>;
  pane?: TmuxQuestionState | null;
}) {
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
      pending={model.pending}
      disabled={false}
      error={model.error}
      notice={null}
      canSubmit={model.canSubmit}
      onChoose={model.choose}
      onPoint={model.point}
      onWriteOther={model.write}
      onSubmit={() => void model.submit()}
    />
  );
}

describe("the live cursor mirror", () => {
  it("points the terminal at the option this reader picked, without answering it", () => {
    const pointed: TmuxQuestionPoint[] = [];
    render(
      <Mirror
        question={CALL}
        answer={async () => ({ answered: true })}
        point={async (_session, wanted) => {
          pointed.push(wanted);
          return { pointed: true };
        }}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "BRAVO" }));

    // The whole call travels, because the sidecar finds its place in the dialog by matching
    // question text rather than by counting tabs.
    //
    // Asserted as the TARGET rather than as a count, because a click that changes the draft points
    // twice: once from the row it was made on and once from the pick itself. That is deliberate.
    // The row has to point on every click, including one that changes nothing, since a radio
    // already checked fires no change event -- and the pick has to point too, or a choice made
    // from the keyboard would never reach the terminal. The second walk presses nothing: the
    // cursor is already where it asks for.
    expect(pointed.length).toBeGreaterThan(0);
    for (const sent of pointed) {
      expect(sent).toEqual({
        questions: ["Which colour?", "Which toppings?"],
        at: 0,
        option: 1,
        label: "BRAVO",
      });
    }
  });

  it("carries on drafting when the terminal will not take the cursor", () => {
    render(
      <Mirror
        question={CALL}
        answer={async () => ({ answered: true })}
        point={async () => {
          throw new Error("no pane");
        }}
      />,
    );

    // The draft is the answer and the point is only a highlight, so a session with no terminal --
    // or one that refuses -- must not stop anybody answering in the panel.
    fireEvent.click(screen.getByRole("radio", { name: "BRAVO" }));
    expect(screen.getByRole("radio", { name: "BRAVO" })).toBeChecked();
    expect(screen.queryByText(/no pane/)).toBeNull();
  });

  it("draws the terminal's cursor without marking anything answered", () => {
    render(
      <Mirror
        question={CALL}
        answer={async () => ({ answered: true })}
        pane={{
          question: "Which colour?",
          prompt: "Which colour?",
          review: false,
          multiSelect: false,
          tabs: [{ label: "Colour", answered: false }],
          options: [
            { label: "ALPHA", detail: "", marked: false, cursor: false },
            { label: "BRAVO", detail: "", marked: false, cursor: true },
          ],
          other: null,
        }}
      />,
    );

    expect(screen.getByTitle("The session's terminal has its cursor on this option")).toBeInTheDocument();
    // A highlight is not an answer. If the cursor were folded into the draft this radio would be
    // checked and Submit would be offering to send an answer nobody gave.
    expect(screen.getByRole("radio", { name: "BRAVO" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  });
});

describe("keeping the panel and the terminal on the same question", () => {
  it("pages to whichever question the terminal is showing", () => {
    render(
      <Mirror
        question={CALL}
        answer={async () => ({ answered: true })}
        pane={{
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
        }}
      />,
    );

    // Nothing was clicked. The terminal moved on to the second question when the first was
    // answered, and a panel left behind on the first drew no cursor for any of the readings that
    // followed -- which is what "nothing mirrors" looked like.
    expect(screen.getByText("Which toppings?")).toBeInTheDocument();
    expect(screen.queryByText("Which colour?")).toBeNull();
  });

  it("points at the option already chosen, so a drifted terminal can be pulled back", () => {
    const pointed: TmuxQuestionPoint[] = [];
    render(
      <Mirror
        question={CALL}
        answer={async () => ({ answered: true })}
        point={async (_session, wanted) => {
          pointed.push(wanted);
          return { pointed: true };
        }}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "BRAVO" }));
    expect(pointed.length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: "BRAVO" })).toBeChecked();

    // The gesture that used to reach nothing at all: a radio that is already checked fires no
    // change event, so picking it again sent nothing -- exactly when a reader wants the terminal
    // brought back to what the panel is showing.
    pointed.length = 0;
    fireEvent.click(screen.getByRole("radio", { name: "BRAVO" }));
    expect(pointed).toEqual([
      {
        questions: ["Which colour?", "Which toppings?"],
        at: 0,
        option: 1,
        label: "BRAVO",
      },
    ]);
    // And it is still only a highlight: re-picking did not unpick the answer.
    expect(screen.getByRole("radio", { name: "BRAVO" })).toBeChecked();
  });
});
