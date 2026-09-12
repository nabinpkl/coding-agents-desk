/**
 * Which view the shell opens on, and the sidebar that chooses it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { storeSidebarPreferences } from "../features/sidebar/sidebarPreferences";
import {
  FIXTURE_PROJECT_A,
  FIXTURE_PROJECT_B,
  READ_ONLY_CAPABILITIES,
  deliverProjectSessions,
  deliverProjects,
  deliverSessions,
  firePointerEvent,
  installViewport,
  openClaudeThread,
  restoreViewport,
  setup,
} from "./agentPanelAppHarness";
import {
  terminalPaneMock,
} from "./agentPanelAppMocks";

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
  it("opens on the Sessions view", () => {
    const { unmount } = setup();
    expect(screen.getByText("Agent Feed")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "false");
    unmount();
  });

  it("comes back to the view that was chosen, not to Sessions", () => {
    // The canvas is somewhere a reader stays: they arrange it, then reload the page many times
    // while working on what it shows. Landing back on Sessions each time means re-choosing the
    // arrangement before the reload has told them anything.
    const first = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    first.unmount();

    const restored = setup();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "false");
    restored.unmount();
  });

  it("names the chosen view in the address, and lets the address win on the way back", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(window.location.search).toBe("?view=canvas");
    first.unmount();

    // The address is what a reload actually carries, so a stored preference must not override it.
    window.history.replaceState(null, "", "/?view=bots");
    const restored = setup();
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "false");
    restored.unmount();
  });

  it("gives the titlebar inset to the header at the window's leading edge", () => {
    const { unmount } = setup();
    const navigationHeader = screen.getByRole("tablist", { name: "Agent views" }).parentElement;
    const threadHeader = screen.getByRole("banner");

    expect(navigationHeader).toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(threadHeader).not.toHaveClass("agent-window-titlebar-main-leading");

    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(screen.queryByRole("tablist", { name: "Agent views" })).not.toBeInTheDocument();
    expect(threadHeader).toHaveClass("agent-window-titlebar-main-leading");
    expect(
      screen.getByRole("button", { name: "Pin agent sidebar" })
        .querySelector(".lucide-panel-left"),
    ).not.toBeNull();
    unmount();
  });

  it("clears the session workspace in the empty Bots view and restores it on return", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No bots yet")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Project")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Claude composer text")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bots");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Bots" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.queryByText("No bots yet")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Session Claude 01");
    unmount();
  });
  it("shows loading before the first project snapshot", () => {
    const { unmount } = setup();
    expect(screen.getByText(/loading projects/i)).toBeInTheDocument();
    unmount();
  });

  it("renders fed projects with their source badges and session counts", () => {
    const { transport, unmount } = setup();

    deliverProjects(transport);

    // Project names
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByText("Beta Project")).toBeInTheDocument();

    // Source badges -- Alpha has both claude and codex sessions
    const claudeBadges = screen.getAllByText("Claude");
    expect(claudeBadges.length).toBeGreaterThanOrEqual(1);
    const codexBadges = screen.getAllByText("Codex");
    expect(codexBadges.length).toBeGreaterThanOrEqual(1);

    // Session counts
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();

    unmount();
  });

  it("expands the newest project and streams its session preview", () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "false");
    expect(transport.subscriptions.map((open) => open.path)).toContainEqual(
      expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_A.projectPath)}`),
    );

    deliverSessions(transport);
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Session Codex 01")).toBeInTheDocument();
    unmount();
  });

  it("keeps several projects expanded with independent subscriptions", () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [{
      sessionId: "sid-beta-01",
      source: "claude",
      title: "Beta session",
      lastEventAt: Date.now(),
      activity: "ready",
      capabilities: READ_ONLY_CAPABILITIES,
    }]);

    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ }));
    // Collapsing drops that project from the one inventory stream, which stays open for
    // the other. However many projects are unfolded, there is exactly one subscription.
    const inventory = transport.subscriptions
      .map((open) => open.path)
      .filter((path) => path.startsWith("/api/inventory/stream"));
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toContain(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`);
    expect(inventory[0]).not.toContain(encodeURIComponent(FIXTURE_PROJECT_A.projectPath));
    expect(screen.queryByText("Session Claude 01")).not.toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();

    unmount();
  });

  it("shows three sessions first and reveals ten more per click", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    const manySessions = Array.from({ length: 24 }, (_, index) => ({
      sessionId: `sid-${index + 1}`,
      source: "codex",
      title: `Session ${String(index + 1).padStart(2, "0")}`,
      lastEventAt: Date.now() - index,
      activity: "ready",
      capabilities: READ_ONLY_CAPABILITIES,
    }));
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, manySessions);

    expect(screen.getByText("Session 03")).toBeInTheDocument();
    expect(screen.queryByText("Session 04")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more (21 remaining)" }));
    expect(screen.getByText("Session 13")).toBeInTheDocument();
    expect(screen.queryByText("Session 14")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more (11 remaining)" }));
    expect(screen.getByText("Session 23")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more (1 remaining)" }));
    expect(screen.getByText("Session 24")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show .* more/ })).not.toBeInTheDocument();

    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, manySessions.slice(0, 2));
    expect(screen.getByText("Session 02")).toBeInTheDocument();
    expect(screen.queryByText("Session 03")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show .* more/ })).not.toBeInTheDocument();

    unmount();
  });

  it("mounts the selected thread while keeping its project sessions visible", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);

    const feed = screen.getByTestId("activity-feed");
    expect(feed).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(feed).toHaveAttribute("data-source", "claude");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Session Claude 01");
    expect(screen.getByText("Session Codex 01")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Session Claude 01/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(fake.posted).not.toContainEqual(expect.objectContaining({ t: "agent-projects-unwatch" }));

    unmount();
  });

  it("preserves expanded projects when project activity reorders the catalog", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));

    act(() => {
      transport.deliver("/api/inventory/stream", {
        projects: [FIXTURE_PROJECT_B, FIXTURE_PROJECT_A],
      });
    });

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");
    unmount();
  });

  it("uses a modal project drawer on compact view and restores focus after dismissal", async () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveAttribute("open");

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveAttribute("open");

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent(drawer, new Event("cancel", { cancelable: true }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());
    unmount();
  });

  it("closes the phone drawer when Canvas is chosen, because the canvas is behind it", () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(drawer).toHaveAttribute("open");

    // Bots keeps its content inside the drawer, so the drawer stays.
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    expect(drawer).toHaveAttribute("open");

    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(drawer).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
    unmount();
  });

  it("keeps compact navigation modal when a mouse or trackpad can hover", () => {
    installViewport({ compact: true, hoverCapable: true });
    const { transport, unmount } = setup();
    deliverProjects(transport);

    // The drawer is already open here. A transient peek layered over it would be two
    // navigations answering one pointer, so hovering the trigger changes nothing.
    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    fireEvent.pointerEnter(trigger);
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Agent navigation" }))
      .toHaveAttribute("open");
    // Width still owns composition: no pointer makes a compact layout grow a pinned column.
    expect(screen.queryByRole("complementary", { name: "Agent navigation" }))
      .not.toBeInTheDocument();
    unmount();
  });

  it("peeks the transient drawer on hover in a window too narrow to pin in", () => {
    vi.useFakeTimers();
    // The Agents window is 480pt wide, which is compact, and it is on a Mac, which hovers. Both
    // at once is the case that used to fall through to the touch story and ignore the mouse.
    installViewport({ compact: true, hoverCapable: true });
    storeSidebarPreferences({ open: false, width: 300, mode: "sessions" });
    const { transport, unmount } = setup();
    deliverProjects(transport);

    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    const preview = screen.getByRole("complementary", { name: "Agent navigation preview" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // An overlay, never the pinned column, and never wide enough to hide the thread behind it.
    expect(screen.queryByRole("complementary", { name: "Agent navigation" }))
      .not.toBeInTheDocument();
    expect(preview).toHaveStyle({ width: "300px", maxWidth: "calc(100% - 3.5rem)" });

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    // Pressing commits to the modal drawer, and the peek is dropped rather than stacked under it.
    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Agent navigation" })).toHaveAttribute("open");
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    unmount();
    vi.useRealTimers();
  });

  it("previews on desktop hover, pins on click, and restores the saved width", () => {
    vi.useFakeTimers();
    installViewport({ compact: false, hoverCapable: true });
    storeSidebarPreferences({ open: false, width: 300, mode: "sessions" });
    const first = setup();
    deliverProjects(first.transport);

    const trigger = screen.getByRole("button", { name: "Pin agent sidebar" });
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("complementary", { name: "Agent navigation preview" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Agent views" }).parentElement)
      .toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 300,
      mode: "sessions",
    });

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Pin agent sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeInTheDocument();

    const separator = screen.getByRole("separator", { name: "Resize agent sidebar" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "316");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 316,
      mode: "sessions",
    });

    firePointerEvent(separator, "pointerdown", { pointerId: 7, clientX: 316 });
    firePointerEvent(separator, "pointermove", { pointerId: 7, clientX: 356 });
    expect(separator).toHaveAttribute("aria-valuenow", "356");
    firePointerEvent(separator, "pointerup", { pointerId: 7, clientX: 356 });
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 356,
      mode: "sessions",
    });

    first.unmount();
    const restored = setup();
    expect(screen.getByRole("separator", { name: "Resize agent sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "356",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(screen.getByRole("button", { name: "Pin agent sidebar" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 356,
      mode: "sessions",
    });
    restored.unmount();
    vi.useRealTimers();
  });
});
