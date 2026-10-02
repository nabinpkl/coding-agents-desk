/**
 * Forking a session from its card: the fork lands on the card's Bot as a card of its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import {
  BOT_WITH_ONE_SESSION,
  FIXTURE_PROJECT_A,
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
  it("forks a session by asking its Bot, and attaches the pane the Bot answers with", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [BOT_WITH_ONE_SESSION],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({
        bot: BOT_WITH_ONE_SESSION,
        started: {
          sessionId: "fork-1",
          title: "Adam (Retry the flaky gate)",
          projectPath: FIXTURE_PROJECT_A.projectPath,
          tmuxSession: "agentdesk-fork-fork-1",
        },
      }),
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));

    // The anchor first, and nothing started yet. `-n` sets the session's address as well as
    // its title, so this is the only moment it is free -- afterwards the fork has already been
    // listed under whatever it was called. A fork onto a Bot starts under the next free anchor
    // with whatever task is typed, not as a `(fork n)` of its source: Aaron is spent, so the
    // field seeds empty under Adam.
    const field = screen.getByLabelText("Task") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(terminalPaneMock.context).toBeNull();

    fireEvent.change(field, { target: { value: "Retry the flaky gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    // Creating a session is the Bot's business: the terminal resource attaches to panes and does
    // not make them. The unticked worktree box sends nothing rather than sending false. The panel
    // sends the task as typed; the sidecar spends the anchor and brackets it.
    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions")?.body)
        .toEqual({
          requestId: expect.any(String),
          launch: {
            title: "Retry the flaky gate",
            from: { source: "claude", sessionId: "sid-claude-01" },
          },
        });
    });

    // A card on the same Bot, open, beside its source -- the canvas stays where it was. It used to
    // take over the whole main column, which put the card the reader had forked from out of sight.
    await waitFor(() => {
      expect(canvas().getByText("Adam (Retry the flaky gate)")).toBeInTheDocument();
    });
    expect(canvas().getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    // A fork has no transcript to show: the CLI writes none until its first turn, so the card says
    // that rather than spinning on a file that is not coming, and it names where it came from.
    expect(canvas().getByText(/forked from Session Claude 01, no transcript yet/)).toBeInTheDocument();
    expect(canvas().getByText(/the transcript appears here once it has one/)).toBeInTheDocument();

    // The pane the Bot named, attached rather than created. The panel does not rebuild that name:
    // it is the sidecar's rule, and a second copy of it here would go wrong silently.
    expect(terminalPaneMock.context).toEqual({ kind: "tmux", session: "agentdesk-fork-fork-1" });
    unmount();
  });

  it("forks from a card's message onto that card's Bot, at the message", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });
    transport.responses.set("GET /api/sessions/claude/sid-claude-01/last-message", {
      status: 200,
      body: JSON.stringify({ eventId: "claude:sid-claude-01:line:4", text: "Try the other way" }),
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({
        bot: BOT_WITH_ONE_SESSION,
        started: {
          sessionId: "fork-2",
          title: "Adam",
          projectPath: FIXTURE_PROJECT_A.projectPath,
          tmuxSession: "agentdesk-fork-fork-2",
          rewindFailed: "rewind refused: no-picker",
        },
      }),
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork from last message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fork" }));

    // The Bot endpoint, with the message: the one that attaches a session before it has spoken.
    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions")?.body)
        .toMatchObject({
          launch: {
            from: { source: "claude", sessionId: "sid-claude-01", eventId: "claude:sid-claude-01:line:4" },
          },
        });
    });
    expect(transport.requests.some((request) => request.path.endsWith("/fork"))).toBe(false);
    await waitFor(() => {
      expect(canvas().getByText(/forked from Session Claude 01/)).toBeInTheDocument();
    });
    // The fork exists either way; a failed rewind is said on its card rather than dropped.
    expect(canvas().getByRole("alert")).toHaveTextContent("rewind refused: no-picker");
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });

  it("does not wait for a fork's first turn to give it to its Bot", async () => {
    // The Bot attached it at the moment it started it, so the transcript landing later is not an
    // event this panel acts on. It used to be: the shell watched the fork's project, recognised
    // the id it had minted, and posted an attach of its own -- three steps that existed only
    // because creation happened somewhere that could not attach anything.
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [BOT_WITH_ONE_SESSION],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({
        bot: BOT_WITH_ONE_SESSION,
        started: {
          sessionId: "fork-1",
          title: "Adam",
          projectPath: FIXTURE_PROJECT_A.projectPath,
          tmuxSession: "agentdesk-fork-fork-1",
        },
      }),
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => {
      expect(terminalPaneMock.context).toEqual({ kind: "tmux", session: "agentdesk-fork-fork-1" });
    });

    // The first turn lands. Nothing follows it.
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, [
      ...FIXTURE_SESSIONS,
      {
        sessionId: "fork-1",
        source: "claude",
        title: "Adam",
        lastEventAt: 9,
        activity: "live",
        capabilities: FIXTURE_SESSIONS[0]!.capabilities,
      },
    ]);

    expect(transport.requests.filter((request) => request.path === "/api/bots/bot-1/sessions"))
      .toHaveLength(1);
    unmount();
  });
  it("starts nothing when the fork dialog is cancelled", async () => {
    // The dialog is the whole commitment point. Backing out of it must leave no pane, no tmux
    // session and no `claude --fork-session`, because a fork that exists is already listed under
    // its name to every other agent and cannot be taken back.
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
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(terminalPaneMock.context).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    // Still the canvas, with no fork view over it. The canvas draws no bar of its own beside a
    // pinned sidebar, so the selected tab is what names the view.
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });
});
