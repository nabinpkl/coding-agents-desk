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
} from "@/app/agentPanelAppHarness";

vi.mock("@/features/activity-feed/ActivityFeed", async () => {
  const { activityFeedModule } = await import("@/app/agentPanelAppMocks");
  return activityFeedModule();
});
vi.mock("@/features/terminal/AgentTerminalPane", async () => {
  const { terminalPaneModule } = await import("@/app/agentPanelAppMocks");
  return terminalPaneModule();
});
vi.mock("@/features/activity-feed/markdown/Markdown", async () => {
  const { markdownModule } = await import("@/app/agentPanelAppMocks");
  return markdownModule();
});
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
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
  const CLI_PATH = "/api/sessions/claude/sid-claude-01/cli";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  function setupInput(status: Record<string, unknown>) {
    const harness = setup();
    harness.transport.responses.set(`GET ${CLI_PATH}`, { status: 200, body: JSON.stringify(status) });
    return harness;
  }

  /** A reading of the session's pane, on the stream the mirror opens once the field is reached for. */
  function paneReads(transport: ReturnType<typeof setup>["transport"], reason: string | null, text = "") {
    act(() => {
      transport.deliver("/composer/stream", {
        composer: { text: reason ? null : text, hint: null, reason, exact: true, commands: [] },
        question: null,
      });
    });
  }

  const TERMINAL = { entrypoint: "cli", tmuxSession: null };

  it("replaces the window composer for a session running in a terminal", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeInTheDocument();
    expect(screen.queryByLabelText("Claude composer text")).toBeNull();
    unmount();
  });

  it("keeps the window composer for a Desktop session, which has a field to mirror", async () => {
    const { transport, unmount } = setupInput({ entrypoint: "claude-desktop", tmuxSession: null });
    openClaudeThread(transport);
    await waitFor(() => {
      expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Message this terminal session")).toBeNull();
    unmount();
  });

  it("sends nothing from a terminal session's band: the draft waits, and there is no send button", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.change(field, { target: { value: "run the tests" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      await Promise.resolve();
    });
    expect((field as HTMLTextAreaElement).value).toBe("run the tests");
    expect(screen.queryByLabelText("Send to the terminal session")).toBeNull();
    // Nothing reaches the session's messaging socket, or any route that once wrote to it.
    expect(transport.requests.some((r) => r.method === "POST" && r.path.startsWith("/api/sessions/claude/"))).toBe(
      false,
    );
    unmount();
  });

  it("hands the draft to the pane's composer once the mirror attaches", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "keep this" } });
    paneReads(transport, null);
    await waitFor(() => expect(screen.queryByLabelText("Message this terminal session")).toBeNull());
    // The draft typed before the mirror attached is what the pane's box is asked to hold.
    await waitFor(
      () =>
        expect(transport.requests).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: "/api/sessions/claude/sid-claude-01/composer",
            body: { text: "keep this" },
          }),
        ),
      { timeout: 3000 },
    );
    unmount();
  });

  it("says so when the session has no tmux pane to type into", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.focus(field);
    paneReads(transport, "no-pane");
    await waitFor(() => expect(screen.getByLabelText("Message this terminal session")).toBeDisabled());
    expect(screen.getByText(/outside a tmux pane, so the panel can't type into it/)).toBeInTheDocument();
    unmount();
  });

  it("says why a draft is waiting when the pane shows no composer, and sends it once one appears", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "do 2" } });
    paneReads(transport, "no-composer");
    expect(await screen.findByText(/not showing its composer.*What you have typed is kept here/)).toBeInTheDocument();
    expect(field).not.toBeDisabled();
    expect((field as HTMLTextAreaElement).value).toBe("do 2");
    paneReads(transport, null);
    await waitFor(() => expect(screen.queryByText(/not showing its composer/)).toBeNull());
    await waitFor(
      () =>
        expect(transport.requests).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: "/api/sessions/claude/sid-claude-01/composer",
            body: { text: "do 2" },
          }),
        ),
      { timeout: 3000 },
    );
    unmount();
  });

  it("falls through a refused window composer to the already-open Agent Feed terminal", async () => {
    const { transport, unmount } = setupInput({ entrypoint: "claude-desktop", tmuxSession: null });
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
    act(() =>
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: "sid-claude-01",
          enabled: false,
          reason: "terminal-only",
          onActiveDesktop: true,
          composerText: "",
        },
      }),
    );

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
    const { transport, unmount } = setupInput({ entrypoint: "claude-desktop", tmuxSession: null });
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
    act(() =>
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: "sid-claude-01",
          enabled: true,
          reason: null,
          onActiveDesktop: true,
          composerText: "native draft",
        },
      }),
    );

    expect(screen.getByLabelText("Claude composer text")).toHaveValue("native draft");
    expect(screen.queryByLabelText("Message through Agent Feed terminal")).toBeNull();
    unmount();
  });

  it("an open Agent Feed terminal takes a terminal session the pane mirror has not reached", async () => {
    const { transport, unmount } = setupInput(TERMINAL);
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeEnabled();

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
    expect(screen.queryByLabelText("Message this terminal session")).toBeNull();
    unmount();
  });
});
