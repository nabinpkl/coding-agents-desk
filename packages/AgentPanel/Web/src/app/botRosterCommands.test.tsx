/**
 * Creating a Bot, and attaching sessions to one from its row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import {
  FIXTURE_PROJECT_A,
  FIXTURE_PROJECT_B,
  FIXTURE_SESSIONS,
  deliverProjectSessions,
  deliverProjects,
  deliverSessions,
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
vi.mock("@/features/activity-feed/DiffBlock", async () => {
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
  it("cannot attach to a Bot whose directory is gone", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-gone",
          name: "Orphan",
          environment: { kind: "directory", path: "/projects/deleted" },
          sessionRefs: [],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "missing",
          sessions: [],
          missingSessionRefs: [],
        }],
      });
    });

    expect(canvas().getByRole("button", { name: "Add sessions to Orphan" })).toBeDisabled();
    unmount();
  });

  it("walks all three views with the arrow keys, wrapping at the ends", () => {
    const { unmount } = setup();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Sessions" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Bots" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");

    // Wrapping, not clamping: the last view is one keystroke from the first.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Canvas" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Sessions" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Canvas" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });

  it("removes an attached session from a Bot through the row's actions menu", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { role: "Coordinates releases", labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
        }],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    // The menu is a sibling of the row's own button, not inside it, so opening it must not also
    // open the session.
    fireEvent.click(screen.getByRole("button", { name: /Actions for Session Claude 01/ }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));

    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions/detach"))
        .toEqual({
          // A POST, because the host relay admits GET and POST only.
          method: "POST",
          path: "/api/bots/bot-1/sessions/detach",
          body: {
            requestId: expect.any(String),
            sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          },
        });
    });
    // Nothing is removed locally: the row leaves when the Bot stream publishes without it, which
    // is also what happens when the same Bot is edited from another surface.
    expect(screen.getByRole("button", { name: /^Session Claude 01/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove from bot" })).not.toBeInTheDocument();
    unmount();
  });

  it("removes a reference whose transcript the catalog has forgotten", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
          metadata: { role: "", labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [],
          // This row has no summary and cannot be opened, so the menu is the only thing that can
          // act on it -- and without one it would be the single entry a Bot can never be rid of.
          missingSessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
        }],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for sid-gone" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));

    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions/detach")?.body)
        .toEqual({
          requestId: expect.any(String),
          sessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
        });
    });
    unmount();
  });

  it("creates a Bot from a name, icon, and existing project directory", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));
    fireEvent.click(screen.getByRole("radio", { name: /Alpha Project/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Release Captain" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Icon URL/ }), { target: { value: "https://example.com/captain.png" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Role/ }), { target: { value: "Coordinates releases" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Labels/ }), { target: { value: "release, platform" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Metadata/ }), { target: { value: "team=platform" } });

    transport.responses.set("POST /api/bots", {
      status: 201,
      body: JSON.stringify({
        botId: "bot-created",
        name: "Release Captain",
        iconUrl: "https://example.com/captain.png",
        environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
        sessionRefs: [],
        metadata: {
          role: "Coordinates releases",
          labels: ["release", "platform"],
          custom: { team: "platform" },
        },
        grants: [],
        createdAt: 1,
        createdBy: { kind: "user" },
        environmentAvailability: "available",
        sessions: [],
        missingSessionRefs: [],
      }),
    });

    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Add Bot" })).getByRole("button", { name: "Add Bot" }));
    });

    expect(transport.requests.find((request) => request.method === "POST" && request.path === "/api/bots")).toEqual({
      method: "POST",
      path: "/api/bots",
      body: expect.objectContaining({
        requestId: expect.any(String),
        name: "Release Captain",
        iconUrl: "https://example.com/captain.png",
        directoryPath: FIXTURE_PROJECT_A.projectPath,
        metadata: {
          role: "Coordinates releases",
          labels: ["release", "platform"],
          custom: { team: "platform" },
        },
        grants: [],
      }),
    });
    expect(screen.queryByRole("dialog", { name: "Add Bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bots");
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    unmount();
  });

  it("attaches sessions from a Bot row using only that Bot directory", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Add sessions to Beta Curator" }));
    await waitFor(() => {
      expect(transport.subscriptions.map((subscription) => subscription.path)).toContainEqual(
        expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`),
      );
    });
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [FIXTURE_SESSIONS[0]]);
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
    expect(screen.queryByRole("dialog", { name: "Add sessions to Beta Curator" })).not.toBeInTheDocument();
    unmount();
  });

});
