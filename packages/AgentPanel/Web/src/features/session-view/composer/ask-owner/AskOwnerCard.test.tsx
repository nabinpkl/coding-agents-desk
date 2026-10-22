import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AskOwnerAnswer, AskOwnerCall, AskOwnerOutcome } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { AskOwnerCard } from "@/features/session-view/composer/ask-owner/AskOwnerCard";
import { useAskOwner, type AskOwnerSender } from "@/features/session-view/composer/ask-owner/useAskOwner";

const SESSION: SessionAddress = { source: "claude", sessionId: "sid-claude-01" };

const CALL: AskOwnerCall = {
  toolUseId: "toolu_01",
  source: "claude",
  sessionId: SESSION.sessionId,
  askedAt: 1,
  questions: [
    {
      id: "auth",
      header: "Auth",
      question: "Which auth method?",
      kind: "single",
      options: [{ label: "OAuth", noteLabel: "Why?" }, { label: "Passwords" }],
    },
    { id: "name", header: "Name", question: "What should it be called?", kind: "text", options: [] },
  ],
};

/** A sidecar that holds what is waiting and records what it was sent. */
function fakeSidecar(outcome: AskOwnerOutcome = { delivered: true }) {
  let push: (asks: AskOwnerCall[]) => void = () => {};
  const sent: AskOwnerAnswer[][] = [];
  const dismissed: string[] = [];
  const sender: AskOwnerSender = {
    subscribeAsks: (_session, onAsks) => {
      push = onAsks;
      onAsks([CALL]);
      return () => {};
    },
    answerAsk: async (_session, _id, answers) => {
      sent.push([...answers]);
      return outcome;
    },
    dismissAsk: async (_session, id) => {
      dismissed.push(id);
      return outcome;
    },
  };
  return { sender, sent, dismissed, push: (asks: AskOwnerCall[]) => push(asks) };
}

function Harness({ sender }: { sender: AskOwnerSender }) {
  const model = useAskOwner(sender, SESSION, true);
  return model ? <AskOwnerCard key={model.call.toolUseId} model={model} /> : <p>nothing waiting</p>;
}

describe("AskOwnerCard", () => {
  it("answers every question with a note and words, and hides the call once delivered", async () => {
    const sidecar = fakeSidecar();
    render(<Harness sender={sidecar.sender} />);
    const submit = screen.getByRole("button", { name: "Submit answer" });

    fireEvent.click(screen.getByRole("radio", { name: "OAuth" }));
    fireEvent.change(screen.getByPlaceholderText("Why?"), { target: { value: "we already use Google" } });
    expect(submit).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer to: What should it be called?" }), {
      target: { value: "Ledger" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit answer" })));

    expect(sidecar.sent).toEqual([
      [
        { id: "auth", chosen: [{ label: "OAuth", note: "we already use Google" }] },
        { id: "name", chosen: [], text: "Ledger" },
      ],
    ]);
    expect(screen.getByText("nothing waiting")).toBeTruthy();
    // And it stays gone when the stream catches up.
    act(() => sidecar.push([]));
    expect(screen.getByText("nothing waiting")).toBeTruthy();
  });

  it("keeps every word written when the sidecar refuses, and says why", async () => {
    const sidecar = fakeSidecar({ delivered: false, reason: "not-waiting", message: "nothing is waiting for that" });
    render(<Harness sender={sidecar.sender} />);
    fireEvent.click(screen.getByRole("radio", { name: "Passwords" }));
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    const words = screen.getByRole("textbox", { name: "Your answer to: What should it be called?" });
    fireEvent.change(words, { target: { value: "Ledger" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit answer" })));

    expect(screen.getByText("nothing is waiting for that")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Your answer to: What should it be called?" })).toHaveProperty(
      "value",
      "Ledger",
    );
  });

  it("dismisses the call without answering", async () => {
    const sidecar = fakeSidecar();
    render(<Harness sender={sidecar.sender} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dismiss question" })));
    expect(sidecar.dismissed).toEqual(["toolu_01"]);
    expect(screen.getByText("nothing waiting")).toBeTruthy();
  });
});
