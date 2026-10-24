/**
 * Starting an opencode session from a Bot: created at the serve, attached, and named only when a
 * task was typed. A handover into opencode is in `botForkCommands.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import {
  BOT_WITH_ONE_SESSION,
  FIXTURE_PROJECT_A,
  FIXTURE_SESSIONS,
  deliverProjects,
  restoreViewport,
  setup,
} from "@/app/agentPanelAppHarness";
import { terminalPaneMock } from "@/app/agentPanelAppMocks";

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

describe("an opencode session started from a Bot", () => {
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

  it("starts an opencode session for a Bot, attaches it, names it, and opens its card", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });
    transport.responses.set("POST /api/agent-sessions", {
      status: 201,
      body: JSON.stringify({
        sessionId: "oc-1",
        source: "opencode",
        projectPath: FIXTURE_PROJECT_A.projectPath,
        title: "New session",
        lastEventAt: 1,
        activity: "ready",
        capabilities: FIXTURE_SESSIONS[0]!.capabilities,
      }),
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ bot: BOT_WITH_ONE_SESSION }),
    });
    transport.responses.set("POST /api/sessions/opencode/oc-1/bracket", {
      status: 200,
      body: JSON.stringify({ title: "Adam (Port the parser)" }),
    });

    fireEvent.click(canvas().getByRole("button", { name: "New session in Release Captain" }));
    // A fresh opencode session has nothing to hand over, so it still starts from the dialog.
    fireEvent.click(await screen.findByRole("button", { name: "Add existing sessions instead" }));
    // Claude in its terminal until the reader says otherwise: the default.
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /opencode/ }));
    fireEvent.change(screen.getByLabelText("Start a new session here"), { target: { value: "Port the parser" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    // Created in the Bot's directory, attached by reference, then named onto the anchor the attach
    // spent -- in that order, because the name needs the anchor.
    await waitFor(() => {
      expect(transport.requests.some((request) => request.path === "/api/sessions/opencode/oc-1/bracket")).toBe(true);
    });
    const asked = transport.requests
      .filter((request) => request.method === "POST")
      .map((request) => ({ path: request.path, body: request.body }));
    expect(asked).toEqual([
      {
        path: "/api/agent-sessions",
        body: { requestId: expect.any(String), source: "opencode", projectPath: FIXTURE_PROJECT_A.projectPath },
      },
      {
        path: "/api/bots/bot-1/sessions",
        body: { requestId: expect.any(String), sessionRefs: [{ source: "opencode", sessionId: "oc-1" }] },
      },
      { path: "/api/sessions/opencode/oc-1/bracket", body: { task: "Port the parser" } },
    ]);
    // No Claude launch, and the canvas is still what is on screen.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");

    // The Bot's next snapshot carries it, and its card is already open.
    const opencodeSession = {
      sessionId: "oc-1",
      source: "opencode",
      title: "Adam (Port the parser)",
      lastEventAt: 2,
      activity: "ready",
      capabilities: FIXTURE_SESSIONS[0]!.capabilities,
    };
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 2,
        bots: [
          {
            ...BOT_WITH_ONE_SESSION,
            sessionRefs: [...BOT_WITH_ONE_SESSION.sessionRefs, { source: "opencode", sessionId: "oc-1" }],
            sessions: [...BOT_WITH_ONE_SESSION.sessions, opencodeSession],
          },
        ],
      });
    });
    await waitFor(() => {
      expect(canvas().getByRole("region", { name: "Adam (Port the parser) session" })).toBeInTheDocument();
    });
    unmount();
  });

  it("leaves an opencode session started with no task unnamed, for opencode to title", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });
    const created = { sessionId: "oc-1", source: "opencode", projectPath: FIXTURE_PROJECT_A.projectPath, title: "" };
    transport.responses.set("POST /api/agent-sessions", {
      status: 201,
      body: JSON.stringify({
        ...created,
        lastEventAt: 1,
        activity: "ready",
        capabilities: FIXTURE_SESSIONS[0]!.capabilities,
      }),
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ bot: BOT_WITH_ONE_SESSION }),
    });

    fireEvent.click(canvas().getByRole("button", { name: "New session in Release Captain" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add existing sessions instead" }));
    fireEvent.click(screen.getByRole("radio", { name: /opencode/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    // Created and attached, then nothing: opencode titles a session from its first prompt only while
    // it has no name, and the Bot's title queue then puts the anchor in front of that title.
    await waitFor(() =>
      expect(transport.requests.some((request) => request.path === "/api/bots/bot-1/sessions")).toBe(true),
    );
    await act(async () => {});
    const posted = transport.requests.filter((request) => request.method === "POST").map((request) => request.path);
    expect(posted).toEqual(["/api/agent-sessions", "/api/bots/bot-1/sessions"]);
    unmount();
  });
});
