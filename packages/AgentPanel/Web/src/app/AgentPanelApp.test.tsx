/**
 * What the shell does that belongs to no one surface.
 *
 * Recovering a stream that failed, spending the safe area once, reopening the thread the
 * reader was on, and the turn summarizer. Each is small, and each is about the shell rather
 * than about a surface inside it, so they stay together rather than becoming four files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import { FakeHostBridge } from "@/features/activity-feed/data-source/HostBridge";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { App } from "@/app/AgentPanelApp";
import {
  FIXTURE_PROJECT_A,
  FIXTURE_PROJECT_B,
  deliverProjects,
  deliverSessions,
  installViewport,
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
vi.mock("@/features/activity-feed/blocks/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("visibility subscriptions recover from failure", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-subscribes after an error instead of sitting on it forever", () => {
    // The host tears a visibility stream down when it reports an error, so before
    // this the first failure was permanent: a restored Agents window that came up
    // one second before its sidecar showed "agent feed is not ready" for the whole
    // session, and only reopening the window cleared it.
    const { transport, unmount } = setup();
    const first = transport.subscriptions.at(-1);
    act(() => {
      transport.fail("/api/inventory/stream", "agent feed is not ready");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("agent feed is not ready");
    // And it says so, so the error does not read as a dead end.
    expect(screen.getByRole("alert")).toHaveTextContent(/retrying/i);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(transport.subscriptions.at(-1)).not.toBe(first);

    // The retry succeeds, and the error gives way to real content.
    deliverProjects(transport);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    unmount();
  });

  it("backs off between attempts rather than asking once a second forever", () => {
    const { transport, unmount } = setup();
    const current = () => transport.subscriptions.at(-1);
    const attempts = [current()];
    const failCurrent = () => {
      act(() => void transport.fail("/api/inventory/stream", "agent feed is not ready"));
    };

    failCurrent();
    act(() => void vi.advanceTimersByTime(1000));
    attempts.push(current());

    // The second failure must wait longer than the first did.
    failCurrent();
    act(() => void vi.advanceTimersByTime(1000));
    expect(current()).toBe(attempts[1]);
    act(() => void vi.advanceTimersByTime(1000));
    attempts.push(current());

    expect(new Set(attempts).size).toBe(3);
    unmount();
  });

  it("retries once however many projects are expanded, and comes back asking for all of them", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));
    const inventorySubscriptions = () => transport.subscriptions.filter(
      (subscription) => subscription.path.startsWith("/api/inventory/stream"),
    );
    const failed = inventorySubscriptions().at(-1);

    act(() => void transport.fail("/api/inventory/stream", "agent feed is not ready"));
    expect(screen.getByRole("alert")).toHaveTextContent("agent feed is not ready");
    act(() => void vi.advanceTimersByTime(30_000));

    // One open subscription, still, and a different one: the whole inventory reopens
    // once. Per-project streams meant an outage produced a retry storm sized by how
    // much of the tree the reader had unfolded.
    expect(inventorySubscriptions()).toHaveLength(1);
    expect(inventorySubscriptions().at(-1)).not.toBe(failed);
    const reopened = inventorySubscriptions().at(-1)!.path;
    for (const project of [FIXTURE_PROJECT_A, FIXTURE_PROJECT_B]) {
      expect(reopened).toContain(`projectPath=${encodeURIComponent(project.projectPath)}`);
    }
    unmount();
  });
});

/**
 * The other half of `viewport-fit=cover` (asserted in viewportMeta.test.ts).
 *
 * Covering hands the page edges the shell would otherwise have reserved, so the page has to pay for
 * them. Unpaid, this is not a cosmetic regression but a worse one than never covering: the composer
 * and the drawer's last project sit under the home indicator, where the system takes the touch.
 *
 * Asserted as classes rather than computed padding because jsdom resolves `env()` to nothing, and
 * on every surface but the phone these are legitimately zero. What is being pinned is that each
 * edge still has an owner -- and specifically WHICH owner, since the reason they sit where they do
 * is that the alternatives drift: the bottom band varies with the thread's state, and the drawer
 * renders in the top layer where the shell's own padding cannot reach it.
 */
describe("safe area insets", () => {
  afterEach(restoreViewport);

  it("spends the horizontal inset once, on the shell every edge-touching surface is inside", () => {
    const { unmount } = setup();
    const column = screen.getByRole("banner").parentElement!;
    const shell = column.parentElement!;

    expect(shell.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(shell.className).toContain("pr-[env(safe-area-inset-right)]");
    unmount();
  });

  it("spends the bottom inset on the column, not on whichever band happens to be last", () => {
    const { unmount } = setup();
    const column = screen.getByRole("banner").parentElement!;

    expect(column.className).toContain("pb-[env(safe-area-inset-bottom)]");
    // The strip it holds back shows the column's own background, so the band above reads as
    // reaching the edge. That only works while `main` states its background instead of inheriting.
    expect(column.className).toContain("bg-card");
    expect(screen.getByRole("main").className).toContain("bg-background");
    unmount();
  });

  it("makes the phone drawer pay its own, being outside the shell that pays for the rest", () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);

    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(drawer.className).toContain("pl-[env(safe-area-inset-left)]");
    // Paid by the Profile row, which is what actually touches the home indicator now that the
    // sidebar ends in one. It used to be padding inside the scroller, back when the list was the
    // last thing in the column; leaving it there would hold back a strip under a row that is
    // already clear of it, and the row itself would sit in the unsafe area.
    const profile = screen.getByRole("button", { name: "Profile" }).parentElement!;
    expect(profile.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(drawer.querySelector(".overflow-y-auto")!.className)
      .not.toContain("pb-[env(safe-area-inset-bottom)]");
    unmount();
  });
});

describe("remembered selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreViewport();
  });

  it("records the open thread's identity, not a copy of its row", () => {
    // The row carries live facts -- activity bin, last event time, capabilities. Storing it would
    // be a second source of truth that nothing refreshes.
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    expect(JSON.parse(localStorage.getItem("agent-panel.selection")!)).toEqual({
      projectPath: FIXTURE_PROJECT_A.projectPath,
      source: "claude",
      sessionId: "sid-claude-01",
    });
    unmount();
  });

  it("reopens that thread after a reload, once its session list arrives", () => {
    // The panel is edited while it is being read; landing on the empty state after every save
    // makes it unusable to develop against.
    localStorage.setItem(
      "agent-panel.selection",
      JSON.stringify({
        projectPath: FIXTURE_PROJECT_A.projectPath,
        source: "claude",
        sessionId: "sid-claude-01",
      }),
    );
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    expect(screen.getByRole("banner")).toHaveTextContent("Session Claude 01");
    unmount();
  });

  it("opens on the empty state when the remembered thread is gone", () => {
    // A deleted or aged-out session simply never matches; nothing is fabricated to stand in.
    localStorage.setItem(
      "agent-panel.selection",
      JSON.stringify({
        projectPath: FIXTURE_PROJECT_A.projectPath,
        source: "claude",
        sessionId: "deleted-session",
      }),
    );
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    expect(screen.getByText("Select a session from Sessions")).toBeInTheDocument();
    unmount();
  });

  it("ignores a stored value of the wrong shape", () => {
    localStorage.setItem("agent-panel.selection", '{"projectPath":"/repo"}');
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    expect(screen.getByText("Select a session from Sessions")).toBeInTheDocument();
    unmount();
  });
});



// ---------------------------------------------------------------------------
// Turn summarizer
// ---------------------------------------------------------------------------

const SUMMARY_CONFIG = {
  staleThresholdMs: 1,
  readyThresholdMs: 1,
  liveWindowMs: 1,
  watcherState: "live",
  sessionCount: 1,
  summaryEnabled: true,
  summaryModel: "opencode-go/deepseek-v4-flash",
};

const SUMMARY_PATH = "/api/sessions/claude/sid-claude-01/summary";

/**
 * Its own harness rather than `setup()`, for one reason: the panel reads `/api/config` in a
 * mount effect, so the answer has to be on the transport BEFORE the App renders. A canned
 * response registered afterwards is registered too late and the button never appears -- which
 * is exactly what the real panel does when the sidecar has no summarizer.
 */
function setupSummary(enabled = true) {
  const fake = new FakeHostBridge();
  const transport = new FakeHttpTransport();
  transport.responses.set("GET /api/config", {
    status: 200,
    body: JSON.stringify(
      enabled ? SUMMARY_CONFIG : { ...SUMMARY_CONFIG, summaryEnabled: false, summaryModel: null },
    ),
  });
  const host = new HostActionsClient(fake, {
    requestIDFactory: (prefix) => `${prefix}-1`,
  });
  render(<App feed={new SidecarDataSource(transport)} host={host} />);
  return { transport };
}

describe("the turn summarizer", () => {
  // The panel persists the selected thread, so without this the second test starts with a
  // thread already open and the title appears in both the sidebar and the header.
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(cleanup);

  it("offers no button when the sidecar has no summarizer model", async () => {
    const { transport } = setupSummary(false);
    openClaudeThread(transport);
    await act(async () => {});

    expect(screen.queryByLabelText(/^Summarize/)).toBeNull();
  });

  it("opens a stream for the selected thread and shows the work before the digest", async () => {
    const { transport } = setupSummary();
    openClaudeThread(transport);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Summarize this turn"));
    });
    expect(transport.subscriptions.some((open) => open.path === SUMMARY_PATH)).toBe(true);

    // The wait for the digest is not dead time: the run is on screen while it happens, first as
    // the reasoning arrives in pieces and then as the block that supersedes them.
    await act(async () => {
      transport.deliver(SUMMARY_PATH, { type: "thinking-delta", text: "Open the dial " });
    });
    expect(screen.getByText("Open the dial")).toBeTruthy();
    await act(async () => {
      transport.deliver(SUMMARY_PATH, { type: "reasoning", text: "It names the dial policy." });
    });
    expect(screen.getByText("It names the dial policy.")).toBeTruthy();

    await act(async () => {
      transport.deliver(SUMMARY_PATH, {
        type: "result",
        result: {
          phase: "final",
          generatedAt: 1,
          model: "opencode-go/deepseek-v4-flash",
          headline: "Renamed the dial policy",
          narrative: "It moved the retry decision into a pure function.",
          filesTouched: [
            { path: "client/SessionDialPolicy.swift", action: "wrote", edits: 1, added: 40, removed: 0 },
          ],
          risks: [],
          reasoning: ["It names the dial policy."],
          coverage: { fromEventIndex: 2, toEventIndex: 9, mode: "nice", truncated: false },
          runState: "idle",
        },
      });
    });

    expect(screen.getByText("Renamed the dial policy")).toBeTruthy();
    expect(screen.getByText("client/SessionDialPolicy.swift")).toBeTruthy();
    // Closed on the terminal message. An EventSource left on an ended stream reopens it, and
    // reopening this one buys another digest.
    expect(transport.subscriptions.some((open) => open.path === SUMMARY_PATH)).toBe(false);
  });

  it("reports a failed summary instead of leaving the button spinning", async () => {
    const { transport } = setupSummary();
    openClaudeThread(transport);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Summarize this turn"));
    });
    await act(async () => {
      transport.deliver(SUMMARY_PATH, {
        type: "error",
        error: { code: "summary-failed", message: "the model timed out", retryable: true },
      });
    });

    expect(screen.getByRole("alert").textContent).toContain("the model timed out");
    expect(screen.getByLabelText("Summarize this turn").getAttribute("aria-busy")).toBe("false");
  });
});
