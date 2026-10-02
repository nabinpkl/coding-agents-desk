/**
 * Renaming and detaching a session from its card. Forking is in `botForkCommands.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import {
  FIXTURE_PROJECT_A,
  FIXTURE_PROJECT_B,
  FIXTURE_SESSIONS,
  deliverProjectSessions,
  deliverProjects,
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
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", async () => {
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

  /** The canvas's own list, so a query cannot pick up a matching row in the sidebar instead. */
  const canvas = () => within(screen.getByRole("list", { name: "Bot canvas" }));
  it("renames a session from its canvas row menu", async () => {
    const { transport, unmount } = setup();
    transport.responses.set("POST /api/sessions/claude/sid-claude-01/title", {
      status: 200,
      body: JSON.stringify({ sessionId: "sid-claude-01", title: "Aaron (What I called it)" }),
    });
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          sessionAnchors: { "claude:sid-claude-01": "Aaron" },
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));

    // Held by one Bot with a stored anchor, so the dialog edits only the bracket task: the
    // anchor is shown, fixed, and the old title seeds the task. The rename composes both halves
    // back together.
    const field = screen.getByLabelText(/Task/) as HTMLInputElement;
    expect(field.value).toBe("Session Claude 01");

    fireEvent.change(field, { target: { value: "  What I called it  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/sessions/claude/sid-claude-01/title",
      body: { title: "Aaron (What I called it)" },
    });
    // Closed on success. The new title arrives through the inventory stream like every other
    // change to a session, so there is nothing for the dialog to hold on to.
    expect(screen.queryByRole("heading", { name: "Rename session" })).toBeNull();
    unmount();
  });

  it("renames an opencode session from its canvas row menu, on the serve rather than in a pane", async () => {
    const { transport, unmount } = setup();
    transport.responses.set("POST /api/agent-sessions/opencode/sid-opencode-01/title", {
      status: 200,
      body: JSON.stringify({ sessionId: "sid-opencode-01", title: "Aaron (What I called it)" }),
    });
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "opencode", sessionId: "sid-opencode-01" }],
          sessionAnchors: { "opencode:sid-opencode-01": "Aaron" },
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [{
            ...FIXTURE_SESSIONS[0]!,
            sessionId: "sid-opencode-01",
            source: "opencode" as const,
            title: "Session Opencode 01",
          }],
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Opencode 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));

    // Not Claude's paragraph. This one is a PATCH to the serve, so the two reasons Claude can be
    // refused -- no running session, unsent text in the composer -- are not this dialog's to warn
    // about, and saying they were would be a warning about a failure that cannot happen.
    expect(screen.getByText(/Renames it on this machine's opencode serve/)).toBeInTheDocument();

    // Held with a stored anchor, so the dialog edits only the bracket task.
    const field = screen.getByLabelText(/Task/) as HTMLInputElement;
    expect(field.value).toBe("Session Opencode 01");
    fireEvent.change(field, { target: { value: "  What I called it  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/opencode/sid-opencode-01/title",
      body: { title: "Aaron (What I called it)" },
    });
    expect(screen.queryByRole("heading", { name: "Rename session" })).toBeNull();
    unmount();
  });

  it("keeps the rename dialog open and says why when the sidecar refuses", async () => {
    const { transport, unmount } = setup();
    transport.responses.set("POST /api/sessions/claude/sid-claude-01/title", {
      status: 400,
      body: JSON.stringify({
        error: { code: "invalid-title", message: "a session title cannot contain a line break" },
      }),
    });
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });

    // The sidecar's own reason, not "sidecar answered 400": the reader has to be able to fix it.
    expect(screen.getByRole("alert")).toHaveTextContent("cannot contain a line break");
    expect(screen.getByRole("heading", { name: "Rename session" })).toBeInTheDocument();
    unmount();
  });

  it("detaches a session from a Bot through its canvas row menu", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [{ source: "codex", sessionId: "sid-forgotten" }],
        }],
      });
    });
    transport.responses.set("DELETE /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    // The menu is a sibling of the row's disclosure, not inside it, so opening the menu must not
    // also open the transcript.
    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));
    });

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions")).toEqual({
      method: "DELETE",
      path: "/api/bots/bot-1/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
      },
    });

    // The row a Bot can otherwise never be rid of: no summary, so no title, and it still has to
    // carry the same action.
    fireEvent.click(canvas().getByRole("button", { name: "Actions for sid-forgotten" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));
    });
    expect(
      transport.requests.filter((request) => request.path === "/api/bots/bot-1/sessions").at(-1)?.body,
    ).toEqual({
      requestId: expect.any(String),
      sessionRefs: [{ source: "codex", sessionId: "sid-forgotten" }],
    });
    unmount();
  });

  it("attaches a session to a Bot from its canvas card", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-beta",
          name: "Beta Curator",
          environment: { kind: "directory", path: FIXTURE_PROJECT_B.projectPath },
          sessionRefs: [],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [],
          missingSessionRefs: [],
        }],
      });
    });

    // The picker reads the Bot's directory off the inventory stream, so opening it from the canvas
    // has to widen that subscription exactly as opening it from the sidebar does.
    fireEvent.click(canvas().getByRole("button", { name: "Add sessions to Beta Curator" }));
    await waitFor(() => {
      expect(transport.subscriptions.map((subscription) => subscription.path)).toContainEqual(
        expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`),
      );
    });
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [FIXTURE_SESSIONS[0]!]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Session Claude 01/ }));

    transport.responses.set("POST /api/bots/bot-beta/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-beta" }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add sessions" }));
    });

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-beta/sessions")).toEqual({
      method: "POST",
      path: "/api/bots/bot-beta/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
      },
    });
    // Attaching leaves the canvas up rather than dropping the reader into the thread.
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });

});
