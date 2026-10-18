/**
 * A fork onto a Bot before it starts: what its card offers, what it sends, and what it keeps when
 * the start is refused.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { BotForkDraftCard, type ForkDraft } from "@/features/bots/cards/BotForkDraftCard";

const SOURCE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Picker driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

function draft(from?: { eventId: string; text: string }): ForkDraft {
  return {
    key: "fork-draft:1",
    request: { session: SOURCE, projectPath: "/repo", botId: "bot-1", ...(from ? { from } : {}) },
  };
}

function renderCard(options: { from?: { eventId: string; text: string }; refusal?: string | null } = {}) {
  const onStart = vi.fn(async () => options.refusal ?? null);
  const onClose = vi.fn();
  render(
    <ul>
      <BotForkDraftCard draft={draft(options.from)} anchor="Adam" onStart={onStart} onClose={onClose} />
    </ul>,
  );
  return { onStart, onClose };
}

afterEach(cleanup);

describe("a fork's draft card", () => {
  it("names its source and starts Claude through the SDK, in the Bot's checkout, by default", async () => {
    const { onStart } = renderCard();
    expect(screen.getByRole("region", { name: "Fork of Picker driver" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Runs in Claude SDK/ })).toBeDefined();
    fireEvent.change(screen.getByLabelText("The fork's first message"), { target: { value: "try teal" } });
    fireEvent.click(screen.getByRole("button", { name: "Start the fork" }));
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith({ task: "", brief: "try teal", harness: "claude-sdk", worktree: false }),
    );
  });

  it("needs a first message to start through the SDK, which it is prompted through", () => {
    const { onStart } = renderCard();
    expect(screen.getByRole("button", { name: "Start the fork" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByLabelText("The fork's first message"), { key: "Enter" });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Runs in Claude SDK/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Code/ }));
    expect(screen.getByRole("button", { name: "Start the fork" })).toHaveProperty("disabled", false);
  });

  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    const { onStart } = renderCard();
    const field = screen.getByLabelText("The fork's first message");
    fireEvent.change(field, { target: { value: "go" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it("offers a worktree for Claude and not for opencode, which takes a handover", async () => {
    const { onStart } = renderCard();
    fireEvent.change(screen.getByLabelText("The fork's first message"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /In the Bot's checkout/ }));
    fireEvent.click(screen.getByRole("button", { name: /Runs in Claude SDK/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /opencode/ }));
    expect(screen.queryByRole("button", { name: /worktree|checkout/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start the fork" }));
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ harness: "opencode", worktree: false })),
    );
  });

  it("from a message: seeded with it, and opencode cannot take it", () => {
    renderCard({ from: { eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" } });
    expect(screen.getByLabelText("The fork's first message")).toHaveProperty("value", "Rewrite the picker driver");
    fireEvent.click(screen.getByRole("button", { name: /Runs in Claude SDK/ }));
    expect(screen.getByRole("menuitemradio", { name: /opencode/ })).toHaveProperty("disabled", true);
  });

  it("keeps every word typed when the start is refused, and says why", async () => {
    renderCard({ refusal: "Could not start the fork: no such Bot" });
    fireEvent.change(screen.getByLabelText("Task, bracketed after the name"), { target: { value: "teal" } });
    fireEvent.change(screen.getByLabelText("The fork's first message"), { target: { value: "try teal" } });
    fireEvent.click(screen.getByRole("button", { name: "Start the fork" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not start the fork: no such Bot");
    expect(screen.getByLabelText("The fork's first message")).toHaveProperty("value", "try teal");
    expect(screen.getByLabelText("Task, bracketed after the name")).toHaveProperty("value", "teal");
    expect(screen.getByRole("button", { name: "Start the fork" })).toHaveProperty("disabled", false);
  });

  it("discards without starting anything", () => {
    const { onStart, onClose } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Discard this fork" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});
