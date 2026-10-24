import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionLogButton, sessionLogPath } from "@/features/bots/code/SessionLogButton";
import { useSessionCode } from "@/features/bots/code/useSessionCode";

const LOG = ".agents/agents-log/lint-manager.log";

const bot = {
  botId: "bot-1",
  name: "AD bot",
  environment: { kind: "directory", path: "/projects/agent-desk" },
  environmentAvailability: "available",
  sessionLogs: { "claude:s-lint": LOG },
} as unknown as BotView;

const keeper = { source: "claude", sessionId: "s-lint", title: "Esther (Lint Manager)" } as SessionSummary;
const other = { source: "claude", sessionId: "s-other", title: "Erica" } as SessionSummary;

it("finds a session's log by source and id, and none for a session that keeps none", () => {
  expect(sessionLogPath(bot, keeper)).toBe(LOG);
  expect(sessionLogPath(bot, other)).toBeNull();
  expect(sessionLogPath({ ...bot, sessionLogs: undefined }, keeper)).toBeNull();
});

it("draws nothing on a session that keeps no log", () => {
  const { container } = render(<SessionLogButton bot={bot} session={other} onOpen={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});

it("opens the log in the session's code viewer", () => {
  const onOpen = vi.fn();
  render(<SessionLogButton bot={bot} session={keeper} onOpen={onOpen} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Read the log lint-manager.log that Esther (Lint Manager) keeps" }),
  );
  expect(onOpen).toHaveBeenCalledWith({ path: LOG, line: null });

  // What the card hands it: the session's own viewer, opened on that file.
  const { result } = renderHook(() => useSessionCode(keeper, bot));
  act(() => result.current.openFile({ path: LOG, line: null }));
  expect(result.current.request).toEqual({ file: { path: LOG, line: null } });
});

it("is disabled while the Bot's directory is missing", () => {
  render(<SessionLogButton bot={{ ...bot, environmentAvailability: "missing" }} session={keeper} onOpen={vi.fn()} />);
  expect(screen.getByRole("button")).toHaveProperty("disabled", true);
});
