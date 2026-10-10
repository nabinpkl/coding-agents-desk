import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionTmuxTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalRestartButton } from "@/features/terminal/TerminalRestartButton";

const context: SessionTmuxTerminalContext = {
  kind: "session-tmux",
  source: "claude",
  sessionId: "11111111-2222-4333-8444-555555555555",
};

function renderButton(restart: (context: SessionTmuxTerminalContext) => Promise<void>) {
  const feed = { restartSessionTerminal: vi.fn(restart) };
  render(<TerminalRestartButton feed={feed as unknown as SidecarDataSource} context={context} />);
  return feed.restartSessionTerminal;
}

afterEach(() => {
  vi.useRealTimers();
});

it("restarts only on a second press, because the first would end a turn in flight", async () => {
  const restart = renderButton(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /Restart this session/ }));
  expect(restart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Press again to restart this session" }));
  expect(restart).toHaveBeenCalledWith(context);
  await waitFor(() => expect(screen.getByRole("button", { name: /Restart this session/ })).toBeTruthy());
});

it("disarms on its own, so a stray press cannot be confirmed later", () => {
  vi.useFakeTimers();
  const restart = renderButton(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /Restart this session/ }));
  act(() => vi.advanceTimersByTime(5_000));
  fireEvent.click(screen.getByRole("button", { name: /Restart this session/ }));
  expect(restart).not.toHaveBeenCalled();
});

it("says why a restart was refused", async () => {
  renderButton(async () => {
    throw new Error("tmux session work was not started by the panel");
  });
  fireEvent.click(screen.getByRole("button", { name: /Restart this session/ }));
  fireEvent.click(screen.getByRole("button", { name: "Press again to restart this session" }));
  expect((await screen.findByRole("status")).textContent).toContain("was not started by the panel");
});
