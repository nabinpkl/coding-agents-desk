/**
 * The Agent Feed terminal across a session change, and the message composer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, within } from "@testing-library/react";
import {
  createPiSession,
  deliverProjects,
  deliverProjectSessions,
  deliverSessions,
  emitTerminalState,
  FIXTURE_PROJECT_A,
  FIXTURE_SESSIONS,
  openClaudeThread,
  restoreViewport,
  setup,
} from "@/app/agentPanelAppHarness";
import {
  terminalPaneMock,
} from "@/app/agentPanelAppMocks";

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
vi.mock("@/features/activity-feed/blocks/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("App shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // The address is app state now -- it names the selected view -- so it has to be reset between
    // tests for the same reason storage does, or one test's choice opens every test after it.
    window.history.replaceState(null, "", "/");
    terminalPaneMock.context = null;
    terminalPaneMock.onState = null;
    terminalPaneMock.composerContext = null;
    terminalPaneMock.composerHasBasis = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });
  it("unmounts the Agent Feed terminal when the viewer closes it", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
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

    fireEvent.click(screen.getByRole("button", { name: "Close Claude terminal" }));
    expect(screen.queryByRole("region", { name: "Claude terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("removes the old pane before replacing the selected thread", () => {
    const { fake, transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    fireEvent.click(screen.getByText("Session Codex 01"));

    expect(screen.queryByRole("region", { name: "Claude terminal" })).not.toBeInTheDocument();
    expect(fake.posted.some((message) =>
      (message as { t?: string }).t?.startsWith("agent-terminal-"))).toBe(false);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    unmount();
  });

  it("opens the replacement session with its own provider context", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: "/projects/alpha",
      source: "codex",
      sessionId: "sid-codex-01",
    });
    unmount();
  });

  it("ignores stale ready after navigation and session replacement", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    const oldContext = terminalPaneMock.context!;
    const oldOnState = terminalPaneMock.onState!;
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    act(() => oldOnState(oldContext, {
      kind: "ready",
      descriptor: {
        terminalId: "stale-terminal",
        ptySessionName: "stale-pty",
        pid: 41,
        columns: 80,
        rows: 24,
      },
    }));
    expect(screen.getByRole("status")).toHaveTextContent("Opening Codex");

    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-2",
        ptySessionName: "agent-resume-codex-sid-codex-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Codex terminal ready");
    unmount();
  });

  it("opens an Opencode terminal under an opencode thread, in the composer and below it", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, [
      ...FIXTURE_SESSIONS,
      {
        sessionId: "ses_abc123",
        source: "opencode",
        title: "Session Opencode 01",
        lastEventAt: Date.now() - 5_000,
        activity: "ready",
        capabilities: {
          modes: ["nice"],
          canSend: true,
          canSteer: true,
          canAbort: true,
          canFetchRaw: false,
          canOpenTerminal: true,
          supportsExtensionUi: true,
          canStreamLive: false,
        },
      },
    ]);
    fireEvent.click(screen.getByText("Session Opencode 01"));

    // Below the composer, through the header control: a shell in the session's directory.
    fireEvent.click(screen.getByRole("button", { name: "Open Opencode terminal" }));
    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: "/projects/alpha",
      source: "opencode",
      sessionId: "ses_abc123",
    });

    // Above the field, through the composer's own toggle: the session's tmux pane.
    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));
    expect(terminalPaneMock.composerContext).toEqual({
      kind: "session-tmux",
      source: "opencode",
      sessionId: "ses_abc123",
    });
    unmount();
  });

  it("creates a Pi session, sends through the composer, and answers extension UI", async () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    await createPiSession(transport);

    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-source", "pi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("SDK-authored Pi session");
    expect(screen.queryByRole("button", { name: /Pi terminal/i })).not.toBeInTheDocument();
    transport.responses.set("POST /api/agent-sessions/pi/pi-1/messages", {
      status: 202,
      body: JSON.stringify({ requestId: "r-send", delivery: "immediate" }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message Pi" }), { target: { value: "Inspect the repo" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/pi/pi-1/messages",
      body: { requestId: expect.any(String), text: "Inspect the repo", delivery: "next" },
    });

    // Prompts ride the thread's own stream, so they cannot outlive the thread that asked them.
    act(() => {
      transport.deliver("/timeline", {
        type: "ui",
        event: {
          type: "request",
          request: { requestId: "ui-1", kind: "confirm", title: "Proceed?", message: "Run it", expectsResponse: true },
        },
      });
      for (let index = 0; index < 12; index += 1) {
        transport.deliver("/timeline", {
          type: "ui",
          event: {
            type: "request",
            request: { requestId: `notice-${index}`, kind: "status", key: "working", message: `Status ${index}`, expectsResponse: false },
          },
        });
      }
    });
    expect(screen.getByRole("dialog", { name: "Proceed?" })).toBeInTheDocument();

    transport.responses.set("POST /api/agent-sessions/pi/pi-1/ui/ui-1", { status: 200, body: "{}" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/pi/pi-1/ui/ui-1",
      body: { value: true },
    });
    act(() => {
      transport.deliver("/timeline", { type: "ui", event: { type: "dismiss", requestId: "ui-1" } });
    });
    expect(screen.queryByRole("dialog", { name: "Proceed?" })).not.toBeInTheDocument();
    unmount();
  });

  it("renders the message composer as a roomy, padded field rather than a single cramped row", async () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    await createPiSession(transport);

    const field = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(field.className).toContain("min-h-12");
    // Left padding only: the right side holds the send, inside the same box.
    expect(field.className).toContain("pl-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    // The ring is on the box around the field rather than the field itself, because the box also
    // holds the images the composer is carrying and its send button, inside the same border.
    expect(field.parentElement?.parentElement?.className).toContain("focus-within:ring-2");
    // No inline height: jsdom measures every box at zero, and writing that would collapse the field
    // to nothing. A degenerate measurement has to leave the utilities in charge.
    expect(field.style.height).toBe("");
    unmount();
  });

  it("sizes a growing field to its content plus its border, not just its content", async () => {
    // `scrollHeight` is the padding box and the field is `border-box`, so a height taken straight
    // from it leaves the field exactly its own border short of the text it holds: an empty one
    // scrolls its placeholder and a draft's last line is clipped. Measured in the running panel
    // before this fix: an empty composer already had 2px of hidden content and could be scrolled.
    const metrics: Record<string, number> = { scrollHeight: 72, offsetHeight: 50, clientHeight: 48 };
    const originals = Object.keys(metrics).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
    ] as const);
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    }

    try {
      const { transport, fake, unmount } = setup();
      deliverProjects(transport);
      deliverSessions(transport);

      await createPiSession(transport);

      const field = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: "a draft long enough to wrap onto a second line" } });

      // 72 of content plus the 2 the border takes (offsetHeight - clientHeight).
      expect(field.style.height).toBe("74px");
      unmount();
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  });
});
