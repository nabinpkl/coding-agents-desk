/**
 * The Canvas tab's Sessions view, and the modal a session picked there opens in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, within } from "@testing-library/react";
import {
  BOT_WITH_ONE_SESSION,
  deliverProjects,
  deliverSessions,
  installViewport,
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

describe("Canvas sessions view", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreViewport();
  });

  /** Scoped, because the sidebar's own top row has a Sessions tab too. */
  const canvasTab = (name: string) =>
    within(screen.getByRole("tablist", { name: "Canvas views" })).getByRole("tab", { name });

  function openCanvas() {
    const harness = setup();
    deliverProjects(harness.transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      harness.transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });
    return harness;
  }

  it("opens a session in a modal and leaves the canvas where it was", () => {
    const { transport, unmount } = openCanvas();
    expect(canvasTab("Bots")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(canvasTab("Sessions"));
    deliverSessions(transport);
    const projects = within(screen.getByRole("list", { name: "Projects" }));
    // Pi is not offered here: the provider is retired, and the Sessions tab keeps its button.
    expect(projects.queryByRole("button", { name: /New Pi session/ })).toBeNull();
    fireEvent.click(projects.getByText("Session Codex 01"));

    const modal = screen.getByRole("dialog", { name: "Session Codex 01" });
    expect(within(modal).getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Bot canvas" })).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole("button", { name: "Close session" }));
    expect(screen.queryByRole("dialog", { name: "Session Codex 01" })).toBeNull();
    unmount();
  });

  it("closes on Escape and on the backdrop", () => {
    const { transport, unmount } = openCanvas();
    fireEvent.click(canvasTab("Sessions"));
    deliverSessions(transport);
    const projects = within(screen.getByRole("list", { name: "Projects" }));

    fireEvent.click(projects.getByText("Session Codex 01"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Close session" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(projects.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
  });

  it("remembers which view was chosen", () => {
    const first = openCanvas();
    fireEvent.click(canvasTab("Sessions"));
    first.unmount();

    const second = setup();
    expect(canvasTab("Sessions")).toHaveAttribute("aria-selected", "true");
    second.unmount();
  });

  it("on the phone, opens Chat from the drawer's menu, with the drawer out of its way", async () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    // Choosing Canvas closes the drawer over it; open it again to reach the Sessions view.
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    fireEvent.click(screen.getByRole("button", { name: "Open agent navigation" }));
    fireEvent.click(canvasTab("Sessions"));

    fireEvent.click(within(drawer).getByRole("button", { name: "Actions for new sessions" }));
    // In the drawer, not under it: a modal drawer covers the body and leaves it unpressable.
    const menu = screen.getByRole("menu", { name: "Actions for new sessions" });
    expect(drawer.contains(menu)).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Chat" }));

    expect(drawer).not.toHaveAttribute("open");
    const field = within(screen.getByRole("dialog", { name: "New chat" })).getByRole("textbox", {
      name: "First message",
    });
    expect(field).toHaveFocus();
    // The drawer hands focus back a frame after it closes, but not away from the field the box took.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(field).toHaveFocus();
    unmount();
  });
});
