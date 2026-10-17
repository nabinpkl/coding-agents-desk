import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import { questionFromPane, usePaneQuestion } from "@/features/session-view/composer/question/questionFromPane";
import { useTmuxQuestion } from "@/features/session-view/composer/question/useTmuxQuestion";

/** A single multi-select question as the pane reports it, its question wrapped over two rows. */
function pane(overrides: Partial<TmuxQuestionState> = {}): TmuxQuestionState {
  return {
    question: "Where do the secrets you want to store come from? Pick every",
    prompt: "Where do the secrets you want to store come from? Pick every source that applies.",
    review: false,
    multiSelect: true,
    tabs: [{ label: "Source", answered: false }],
    options: [
      { label: "Existing .env files", detail: "Keys already on disk.", marked: false, cursor: true },
      { label: "Provider CLI or API", detail: "", marked: true, cursor: false },
    ],
    other: null,
    ...overrides,
  };
}

describe("a question read off the terminal", () => {
  it("draws the whole question with each option's detail as its description", () => {
    expect(questionFromPane(pane())).toEqual({
      callId: "pane:Where do the secrets you want to store come from? Pick every",
      questions: [{
        question: "Where do the secrets you want to store come from? Pick every source that applies.",
        multiSelect: true,
        options: [
          { label: "Existing .env files", description: "Keys already on disk." },
          { label: "Provider CLI or API" },
        ],
      }],
      pane: { unseen: 0 },
    });
  });

  it("is nothing while the pane shows no question to read", () => {
    expect(questionFromPane(null)).toBeNull();
    expect(questionFromPane(pane({ question: null, prompt: null, review: true }))).toBeNull();
    expect(questionFromPane(pane({ options: [] }))).toBeNull();
  });

  it("counts the questions of a longer call the screen cannot show", () => {
    const shown = questionFromPane(pane({
      tabs: [{ label: "Source", answered: false }, { label: "Scope", answered: false }],
    }));
    expect(shown?.pane).toEqual({ unseen: 1 });
  });

  it("answers in terms the pane's own driver will match", async () => {
    // The driver finds its question by the first line and its rows by their labels, by prefix, so a
    // question built from the screen has to round-trip through both.
    const answer = vi.fn(async () => ({ answered: true as const }));
    const feed = { answerTmuxQuestion: answer, pointTmuxQuestion: vi.fn(async () => ({ pointed: true as const })) };
    const reading = pane();
    const { result } = renderHook(() =>
      useTmuxQuestion(feed, { source: "claude", sessionId: "sid" }, questionFromPane(reading), reading)
    );
    // The terminal's own tick and cursor are followed, which only works if the two match up.
    expect(result.current.drafts[0]!.chosen).toEqual([1]);
    expect(result.current.paneCursor).toEqual({ at: 0, option: 0 });
    await act(async () => {
      await result.current.submit();
    });
    expect(answer).toHaveBeenCalledWith({ source: "claude", sessionId: "sid" }, [{
      question: "Where do the secrets you want to store come from? Pick every source that applies.",
      chosen: [{ index: 1, label: "Provider CLI or API" }],
      other: "",
    }]);
  });

  it("stays up through the review screen, and goes only with the dialog", () => {
    const { result, rerender } = renderHook(({ reading }) => usePaneQuestion(reading), {
      initialProps: { reading: pane() as TmuxQuestionState | null },
    });
    const asked = result.current;
    expect(asked).not.toBeNull();
    rerender({ reading: pane({ question: null, prompt: null, review: true, options: [] }) });
    expect(result.current).toBe(asked);
    rerender({ reading: null });
    expect(result.current).toBeNull();
  });
});
