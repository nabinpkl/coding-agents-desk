/**
 * The Canvas tab's Sessions view across two machines: each one's sessions are listed, and a session
 * from the other machine is opened and moved on that machine, not on the one the shell points at.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "@/app/AgentPanelApp";
import { deliverProjects, restoreViewport } from "@/app/agentPanelAppHarness";
import { terminalPaneMock } from "@/app/agentPanelAppMocks";
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
  return { mac, oracle, oracleFeed: machines[1]!.feed, unmount };
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

  it("starts a session on the other machine when New session picks it, and follows it there", async () => {
    const { mac, oracle, oracleFeed, unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog", { name: "New session" }));
    fireEvent.click(dialog.getByRole("button", { name: "oracle" }));
    act(() => oracle.deliver("/api/inventory/stream", { projects: [RAGS] }));
    fireEvent.click(dialog.getByRole("radio", { name: /rags/ }));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Fresh on oracle" } });
    fireEvent.change(dialog.getByLabelText("First message"), { target: { value: "Look around" } });
    const started = {
      sessionId: "sid-new",
      source: "claude",
      title: "Fresh on oracle",
      projectPath: RAGS.projectPath,
      tmuxSession: "t",
    };
    oracle.responses.set("POST /api/agent-sessions/start", { status: 200, body: JSON.stringify(started) });
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Start session" }));
    });
    expect(oracle.requests.some((each) => each.path === "/api/agent-sessions/start")).toBe(true);
    expect(mac.requests.some((each) => each.path === "/api/agent-sessions/start")).toBe(false);
    // Its box attaches to its terminal on oracle, and only oracle is asked about its folder.
    expect(terminalPaneMock.context).toMatchObject({ kind: "tmux", session: "t" });
    expect(terminalPaneMock.feed).toBe(oracleFeed);
    const folder = `projectPath=${encodeURIComponent(RAGS.projectPath)}`;
    expect(mac.subscriptions.some((each) => each.path.includes(folder))).toBe(false);

    act(() =>
      oracle.deliver(folder, {
        projectPath: RAGS.projectPath,
        sessions: [{ ...OLIVE, sessionId: "sid-new", title: "Fresh on oracle" }],
      }),
    );
    // Listed: handed to the ordinary session window, which reads its transcript from oracle.
    expect(screen.getByRole("dialog", { name: "Fresh on oracle" })).toBeInTheDocument();
    expect(oracle.subscriptions.some((each) => each.path.includes("sid-new"))).toBe(true);
    expect(mac.subscriptions.some((each) => each.path.includes("sid-new"))).toBe(false);
    unmount();
  });

  it("keeps an open session's window on its name when the other machine renames it", () => {
    const { mac, oracle, unmount } = setup();
    const noReviews = { count: 0, live: 0, recent: [], more: false };
    fireEvent.click(screen.getByRole("button", { name: "Group by project" }));
    act(() => {
      mac.deliver("recent=", { recent: [], more: false, securityReviews: noReviews });
      oracle.deliver("recent=", { projects: [RAGS] });
      oracle.deliver("recent=", { recent: [OLIVE], more: false, securityReviews: noReviews });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Olive on oracle/ }));
    expect(screen.getByRole("dialog", { name: "Olive on oracle" })).toBeInTheDocument();

    // Nothing the panel follows lists its folder, so the window reads it on oracle while it is open.
    act(() =>
      oracle.deliver(`projectPath=${encodeURIComponent(RAGS.projectPath)}`, {
        projectPath: RAGS.projectPath,
        sessions: [{ ...OLIVE, title: "Olive, renamed" }],
      }),
    );
    expect(screen.getByRole("dialog", { name: "Olive, renamed" })).toBeInTheDocument();
    unmount();
  });

  it("starts a chat on the other machine when the Chat box picks it, and follows it there", async () => {
    const { mac, oracle, unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for new sessions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
    const box = within(screen.getByRole("dialog", { name: "New chat" }));
    fireEvent.click(within(box.getByRole("group", { name: "Machine" })).getByRole("button", { name: "oracle" }));
    fireEvent.change(box.getByRole("textbox", { name: "First message" }), { target: { value: "Plan the garden" } });
    const scratch = "/home/ubuntu/.agentdesk/scratch/plan-the-garden-1a2b";
    const started = {
      sessionId: "sid-chat",
      source: "claude",
      title: "Plan the garden",
      projectPath: scratch,
      tmuxSession: "",
    };
    oracle.responses.set("POST /api/agent-sessions/start-scratch", { status: 200, body: JSON.stringify(started) });
    await act(async () => {
      fireEvent.click(box.getByRole("button", { name: "Send" }));
    });
    expect(oracle.requests.some((each) => each.path === "/api/agent-sessions/start-scratch")).toBe(true);
    expect(mac.requests.some((each) => each.path === "/api/agent-sessions/start-scratch")).toBe(false);
    // Its folder is read on oracle until the catalog lists the chat, never on this machine.
    const folder = `projectPath=${encodeURIComponent(scratch)}`;
    expect(mac.subscriptions.some((each) => each.path.includes(folder))).toBe(false);
    act(() =>
      oracle.deliver(folder, {
        projectPath: scratch,
        sessions: [{ ...OLIVE, sessionId: "sid-chat", title: "Plan the garden", projectPath: scratch }],
      }),
    );
    expect(screen.getByRole("dialog", { name: "Plan the garden" })).toBeInTheDocument();
    expect(oracle.subscriptions.some((each) => each.path.includes("sid-chat"))).toBe(true);
    expect(mac.subscriptions.some((each) => each.path.includes("sid-chat"))).toBe(false);
    unmount();
  });
});
