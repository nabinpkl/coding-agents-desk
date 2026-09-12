/**
 * Typing at a session that is running in a terminal rather than a window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import {
  COMPOSER_STREAM,
  emitTerminalState,
  openClaudeThread,
  restoreViewport,
  setup,
} from "./agentPanelAppHarness";

vi.mock("../features/activity-feed/ActivityFeed", async () => {
  const { activityFeedModule } = await import("./agentPanelAppMocks");
  return activityFeedModule();
});
vi.mock("../features/terminal/AgentTerminalPane", async () => {
  const { terminalPaneModule } = await import("./agentPanelAppMocks");
  return terminalPaneModule();
});
vi.mock("../features/activity-feed/markdown/Markdown", async () => {
  const { markdownModule } = await import("./agentPanelAppMocks");
  return markdownModule();
});
vi.mock("../features/activity-feed/DiffBlock", async () => {
  const { diffBlockModule } = await import("./agentPanelAppMocks");
  return diffBlockModule();
});

/**
 * A Claude session running in a terminal takes a different composer from one running in a window.
 *
 * The distinction is not cosmetic. The window band mirrors an actual text field, so it has a draft
 * to read back, an Enter to press in someone else's app, and a Desktop to bring the window from. A
 * terminal session has none of that: there is one thing to do, which is hand it a turn.
 */
describe("terminal session composer", () => {
  const INPUT_PATH = "/api/sessions/claude/sid-claude-01/input";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  function setupInput(status: Record<string, unknown>, receipt?: Record<string, unknown>) {
    const harness = setup();
    harness.transport.responses.set(`GET ${INPUT_PATH}`, {
      status: 200,
      body: JSON.stringify(status),
    });
    if (receipt) {
      harness.transport.responses.set(`POST ${INPUT_PATH}`, {
        status: 200,
        body: JSON.stringify(receipt),
      });
    }
    return harness;
  }

  it("replaces the window composer for a session running in a terminal", async () => {
    const { transport, unmount } = setupInput({ available: true, entrypoint: "cli", reason: null });
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeInTheDocument();
    expect(screen.queryByLabelText("Claude composer text")).toBeNull();
    unmount();
  });

  it("keeps the window composer for a Desktop session, which has a field to mirror", async () => {
    const { transport, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    openClaudeThread(transport);
    await waitFor(() => {
      expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Message this terminal session")).toBeNull();
    unmount();
  });

  it("posts the turn to the session's inbox and clears the draft", async () => {
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: true, reason: null },
    );
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.change(field, { target: { value: "run the tests" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send to the terminal session"));
      await Promise.resolve();
    });
    expect(transport.requests).toContainEqual({
      method: "POST",
      path: INPUT_PATH,
      body: { text: "run the tests" },
    });
    await waitFor(() => {
      expect((field as HTMLTextAreaElement).value).toBe("");
    });
    unmount();
  });

  it("keeps the draft when the session refused it, and says why", async () => {
    // The turn is the expensive thing the viewer typed on a phone. Losing it because a terminal
    // was closed is the failure worth designing against.
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: false, reason: "unreachable" },
    );
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.change(field, { target: { value: "still here" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send to the terminal session"));
      await Promise.resolve();
    });
    expect((field as HTMLTextAreaElement).value).toBe("still here");
    await waitFor(() => {
      expect(screen.getByText(/stopped listening/)).toBeInTheDocument();
    });
    unmount();
  });

  it("re-asks on focus, so a session started after the panel opened becomes writable", async () => {
    const { transport, unmount } = setupInput({
      available: false,
      entrypoint: "cli",
      reason: "not-running",
    });
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    expect(field).toBeDisabled();
    transport.responses.set(`GET ${INPUT_PATH}`, {
      status: 200,
      body: JSON.stringify({ available: true, entrypoint: "cli", reason: null }),
    });
    await act(async () => {
      fireEvent.focus(field);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Message this terminal session")).not.toBeDisabled();
    });
    unmount();
  });

  it("falls through a refused window composer to the already-open Agent Feed terminal", async () => {
    const { transport, fake, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    openClaudeThread(transport);
    const windowField = await screen.findByLabelText("Claude composer text");

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    fireEvent.focus(windowField);
    fireEvent.change(windowField, { target: { value: "keep this draft" } });
    act(() => transport.deliver(COMPOSER_STREAM, {
      composer: {
        sessionId: "sid-claude-01",
        enabled: false,
        reason: "terminal-only",
        onActiveDesktop: true,
        composerText: "",
      },
    }));

    const terminalField = await screen.findByLabelText("Message through Agent Feed terminal");
    await waitFor(() => expect(terminalField).toHaveValue("keep this draft"));
    expect(screen.getByLabelText("Agent Feed terminal composer")).toHaveTextContent(
      "Sending through the open Agent Feed terminal",
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send through Agent Feed terminal"));
    });
    expect(transport.requests).toContainEqual({
      method: "POST",
      path: "/api/terminals/terminal-1/input",
      body: { data: "\u001b[200~keep this draft\u001b[201~\r", encoding: "utf8" },
    });
    await waitFor(() => expect(terminalField).toHaveValue(""));
    // The window composer's stream closed when the field went away, which is what releases the
    // window's editing lease and stops the sidecar's poll.
    expect(transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM))).toBe(false);
    unmount();
  });

  it("keeps an available native window ahead of the Agent Feed terminal", async () => {
    const { transport, fake, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    openClaudeThread(transport);
    const windowField = await screen.findByLabelText("Claude composer text");
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    fireEvent.focus(windowField);
    act(() => transport.deliver(COMPOSER_STREAM, {
      composer: {
        sessionId: "sid-claude-01",
        enabled: true,
        reason: null,
        onActiveDesktop: true,
        composerText: "native draft",
      },
    }));

    expect(screen.getByLabelText("Claude composer text")).toHaveValue("native draft");
    expect(screen.queryByLabelText("Message through Agent Feed terminal")).toBeNull();
    unmount();
  });

  it("keeps an available CLI inbox ahead of the Agent Feed terminal", async () => {
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: true, reason: null },
    );
    openClaudeThread(transport);
    await screen.findByLabelText("Message this terminal session");
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });

    expect(screen.getByLabelText("Message this terminal session")).toBeEnabled();
    expect(screen.queryByLabelText("Message through Agent Feed terminal")).toBeNull();
    unmount();
  });

  it("uses the Agent Feed terminal when the detected CLI inbox is unavailable", async () => {
    const { transport, unmount } = setupInput({
      available: false,
      entrypoint: "cli",
      reason: "no-inbox",
    });
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });

    expect(await screen.findByLabelText("Message through Agent Feed terminal")).toBeEnabled();
    unmount();
  });
});
