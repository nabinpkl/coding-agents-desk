/**
 * The Canvas tab's Sessions view across two machines: each one's sessions are listed, and a session
 * from the other machine is opened and moved on that machine, not on the one the shell points at.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "@/app/AgentPanelApp";
import { deliverProjects, restoreViewport } from "@/app/agentPanelAppHarness";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import { FakeHostBridge } from "@/features/activity-feed/data-source/HostBridge";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";

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

const RAGS = {
  projectPath: "/home/ubuntu/rags",
  displayName: "rags",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: Date.now(),
};
const OLIVE = {
  sessionId: "sid-oracle-01",
  source: "claude" as const,
  title: "Olive on oracle",
  lastEventAt: Date.now(),
  activity: "ready" as const,
  projectPath: RAGS.projectPath,
  capabilities: {
    modes: ["raw", "nice"],
    canSend: false,
    canSteer: false,
    canAbort: false,
    canFetchRaw: true,
    canOpenTerminal: true,
    supportsExtensionUi: false,
    canStreamLive: false,
  },
};

function setup() {
  const mac = new FakeHttpTransport();
  const oracle = new FakeHttpTransport();
  const host = new HostActionsClient(new FakeHostBridge());
  const machines = [
    { label: "mac", feed: new SidecarDataSource(mac) },
    { id: "oracle", label: "oracle", feed: new SidecarDataSource(oracle) },
  ];
  const { unmount } = render(<App feed={machines[0]!.feed} host={host} machines={machines} />);
  act(() => {
    mac.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });
    oracle.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });
  });
  deliverProjects(mac);
  fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
  fireEvent.click(within(screen.getByRole("tablist", { name: "Canvas views" })).getByRole("tab", { name: "Sessions" }));
  return { mac, oracle, unmount };
}

const inventoryStreams = (transport: FakeHttpTransport) =>
  transport.subscriptions.filter((each) => each.path.startsWith("/api/inventory/stream"));

describe("the Sessions view on two machines", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreViewport();
  });

  it("reads the other machine only while the view is on screen", () => {
    const { oracle, unmount } = setup();
    expect(inventoryStreams(oracle)).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("tablist", { name: "Canvas views" })).getByRole("tab", { name: "Bots" }));
    expect(inventoryStreams(oracle)).toHaveLength(0);
    unmount();
  });

  it("lists the other machine's projects under its name and opens its session from there", () => {
    const { mac, oracle, unmount } = setup();
    act(() => oracle.deliver("/api/inventory/stream", { projects: [RAGS] }));

    const there = within(screen.getByRole("region", { name: "oracle" }));
    expect(within(screen.getByRole("region", { name: "mac" })).getByText("Alpha Project")).toBeInTheDocument();
    fireEvent.click(there.getByRole("button", { name: /^rags/ }));
    // Unfolding asks that machine's stream for the folder, not this one's.
    act(() =>
      oracle.deliver(`projectPath=${encodeURIComponent(RAGS.projectPath)}`, {
        projectPath: RAGS.projectPath,
        sessions: [OLIVE],
      }),
    );
    expect(mac.subscriptions.some((each) => each.path.includes(encodeURIComponent(RAGS.projectPath)))).toBe(false);

    fireEvent.click(there.getByText("Olive on oracle"));
    expect(screen.getByRole("dialog", { name: "Olive on oracle" })).toBeInTheDocument();
    // The transcript is read from the machine the session is on.
    expect(oracle.subscriptions.some((each) => each.path.includes(OLIVE.sessionId))).toBe(true);
    expect(mac.subscriptions.some((each) => each.path.includes(OLIVE.sessionId))).toBe(false);
    unmount();
  });

  it("moves the other machine's session onto the canvas on that machine", async () => {
    const { mac, oracle, unmount } = setup();
    act(() => oracle.deliver("/api/inventory/stream", { projects: [RAGS] }));
    fireEvent.click(within(screen.getByRole("region", { name: "oracle" })).getByRole("button", { name: /^rags/ }));
    act(() =>
      oracle.deliver(`projectPath=${encodeURIComponent(RAGS.projectPath)}`, {
        projectPath: RAGS.projectPath,
        sessions: [OLIVE],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions for Olive on oracle" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to canvas" }));
    });
    expect(oracle.requests.filter((each) => each.path === "/api/bots/placements")).toHaveLength(1);
    expect(mac.requests.some((each) => each.path === "/api/bots/placements")).toBe(false);
    unmount();
  });
});
