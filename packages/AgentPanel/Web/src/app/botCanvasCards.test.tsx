/**
 * The Bot canvas: what stands on it, and what opening a card gives a reader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import {
  BOT_WITH_ONE_SESSION,
  deliverRunningTask,
  deliverTwoBots,
  FIXTURE_PROJECT_A,
  FIXTURE_PROJECT_B,
  FIXTURE_SESSIONS,
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
  it("renders the curated Bot roster and opens one of its attached existing sessions", () => {
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
          iconUrl: "https://example.com/captain.png",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { role: "Coordinates releases", labels: ["release"], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]],
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /^Session Claude 01/ }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Release Captain");
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    unmount();
  });

  /**
   * The canvas half of the screen.
   *
   * Scoping matters here in a way it did not before: the sidebar beside the canvas is the same Bot
   * roster with the same session rows and the same buttons, so an unscoped query for "Add sessions
   * to Release Captain" now finds two. Which one a test means is part of what it is asserting.
   */
  const canvas = () => within(screen.getByRole("list", { name: "Bot canvas" }));

  it("comes back to the part of the canvas the reader was on, and lets an open card stay put", () => {
    // Both halves of one complaint. The strip is wider than the panel, so a reader scrolls along it
    // to whichever Bots they are watching; a reload used to open at the left edge, and then the
    // cards restored open scrolled themselves into view, so where a reader landed was decided by
    // whichever of them mounted last.
    localStorage.setItem("agent-panel.bot-canvas.scroll", JSON.stringify({ left: 640, top: 0 }));
    localStorage.setItem(
      "agent-panel.bot-canvas.open-session",
      JSON.stringify(["claude:sid-claude-01"]),
    );
    // jsdom lays nothing out, so the strip has no width to scroll along and the restore would
    // rightly decline to write an offset into a scroller with no overflow.
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, value: 4000 });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const { transport, unmount } = setup();
      deliverProjects(transport);
      deliverSessions(transport);
      fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
      act(() => {
        transport.deliver("/api/bots/stream", {
          version: 2,
          revision: 1,
          bots: [BOT_WITH_ONE_SESSION],
        });
      });

      // The scrolling ancestor rather than the immediate parent: the zoom mode keeps a wrapper
      // between the two, permanently, so that turning the mode on cannot move the strip in the
      // tree and remount every open session inside it.
      const scroller = screen
        .getByRole("list", { name: "Bot canvas" })
        .closest(".overflow-auto") as HTMLElement;
      expect(scroller.scrollLeft).toBe(640);
      // The card holding the restored session is open, and did not drag the strip to itself.
      expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(scrollIntoView).not.toHaveBeenCalled();

      // Opening one from the sidebar still brings its card forward: that is a card BECOMING open,
      // which is the case the scroll was written for.
      fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
      fireEvent.click(
        within(screen.getByRole("list", { name: "Bots" }))
          .getByRole("button", { name: /^Session Claude 01/ }),
      );
      expect(scrollIntoView).toHaveBeenCalled();
      unmount();
    } finally {
      scrollIntoView.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
  });

  it("writes down where the canvas was left once the scrolling stops", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, value: 4000 });
    try {
      const { transport, unmount } = setup();
      deliverProjects(transport);
      fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
      act(() => {
        transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
      });

      // The scrolling ancestor rather than the immediate parent: the zoom mode keeps a wrapper
      // between the two, permanently, so that turning the mode on cannot move the strip in the
      // tree and remount every open session inside it.
      const scroller = screen
        .getByRole("list", { name: "Bot canvas" })
        .closest(".overflow-auto") as HTMLElement;
      scroller.scrollLeft = 320;
      fireEvent.scroll(scroller);
      // On a delay, so a flick is one storage write rather than one per frame.
      expect(localStorage.getItem("agent-panel.bot-canvas.scroll")).toBeNull();
      await waitFor(
        () => expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.scroll") ?? "null"))
          .toEqual({ left: 320, top: 0 }),
        { timeout: 2000 },
      );
      unmount();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
  });

  it("keeps asking for the remembered place while the strip is still growing under it", async () => {
    // The ratchet this was written for. A card that mounts open finishes filling in after the
    // restore has already fired, so the strip is narrower at that moment than it ends up: measured
    // in a real browser, 4569px wide when the restore ran and 4911px a moment later. The browser
    // clamps the assignment to what the strip reaches, and the settle write below then made that
    // clamped offset the new remembered one, walking the reader further off on every reload.
    localStorage.setItem("agent-panel.bot-canvas.scroll", JSON.stringify({ left: 1800, top: 0 }));
    // jsdom lays nothing out and does not clamp a scroll, so both halves are stood up by hand: an
    // extent that grows, and a scroller that refuses to go past it the way a browser would.
    let extent = 1000;
    let at = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => extent });
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
      configurable: true,
      get: () => at,
      set(value: number) { at = Math.min(value, extent); },
    });
    try {
      const { transport, unmount } = setup();
      deliverProjects(transport);
      fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
      act(() => {
        transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
      });
      const scroller = screen
        .getByRole("list", { name: "Bot canvas" })
        .closest(".overflow-auto") as HTMLElement;
      expect(scroller.scrollLeft).toBe(1000);
      // The scroll a browser raises for that clamped landing, which is the event that used to be
      // taken for the reader having chosen to be there and written down as the new place.
      fireEvent.scroll(scroller);

      // The cards finish filling in, which reaches this component as nothing at all -- no render,
      // no event -- which is why the hold re-applies on a frame rather than on a commit.
      extent = 3000;
      await waitFor(() => expect(scroller.scrollLeft).toBe(1800), { timeout: 2000 });
      // And the place it was asked for is still the remembered one, rather than where it got to.
      expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.scroll") ?? "null"))
        .toEqual({ left: 1800, top: 0 });
      unmount();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
      Reflect.deleteProperty(HTMLElement.prototype, "scrollLeft");
    }
  });

  /**
   * A reference the reader took off this canvas does not come back as a row, missing or not.
   *
   * Measured 2026-09-26: a sidecar restart's half-reconciled catalog made every Claude reference on
   * a Bot read as `missing`, and the card rendered all of them -- including the ones the reader had
   * deliberately detached -- as rows saying `missing`, which pushed the card's contents down and gave
   * the Bot a second, wrong session strip. The sidecar now tells the panel when a reference resolves
   * again, so the rows do not appear at all; this is the other half, for the case where a reference
   * really is gone and the reader really did put it away.
   */
  it("does not draw a missing reference the reader detached from this canvas", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [
          {
            botId: "bot-1",
            name: "Release Captain",
            environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
            sessionRefs: [
              { source: "claude", sessionId: "sid-claude-01" },
              { source: "claude", sessionId: "sid-kept" },
              { source: "claude", sessionId: "sid-put-away" },
            ],
            metadata: { role: "Coordinates releases", labels: [], custom: {} },
            grants: [],
            createdAt: 1,
            createdBy: { kind: "user" },
            environmentAvailability: "available",
            canvasPosition: 1,
            sessions: [FIXTURE_SESSIONS[0]!],
            // One this canvas is showing, one the reader put away. Both unresolvable.
            missingSessionRefs: [
              { source: "claude", sessionId: "sid-kept" },
              { source: "claude", sessionId: "sid-put-away" },
            ],
            offCanvasSessionRefs: [{ source: "claude", sessionId: "sid-put-away" }],
          },
        ],
      });
    });

    // The one the canvas is showing is still a row, and still says why.
    expect(canvas().getByText("sid-kept")).toBeInTheDocument();
    // The one the reader detached is not, and is counted with everything else they put away: one
    // shown session, and one off the canvas -- the detached reference that cannot resolve.
    expect(canvas().queryByText("sid-put-away")).toBeNull();
    expect(canvas().getByText(/1 off the canvas/)).toBeInTheDocument();
    unmount();
  });

  it("shows every Bot at once on the canvas, and opens their sessions inline beside each other", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [
          {
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
          },
          {
            botId: "bot-2",
            name: "Docs Keeper",
            environment: { kind: "directory", path: FIXTURE_PROJECT_B.projectPath },
            sessionRefs: [{ source: "codex", sessionId: "sid-codex-01" }],
            metadata: { labels: [], custom: {} },
            grants: [],
            createdAt: 2,
            createdBy: { kind: "user" },
            environmentAvailability: "available",
            sessions: [FIXTURE_SESSIONS[1]!],
            missingSessionRefs: [{ source: "claude", sessionId: "sid-gone" }],
          },
        ],
      });
    });

    // The point of the view: both Bots and both their sessions are on screen together, with
    // nothing selected and no Bot picked. The selected tab is what says so -- the canvas draws no
    // bar of its own over a pinned sidebar that already names it.
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("banner")).toBeNull();
    expect(canvas().getByText("Release Captain")).toBeInTheDocument();
    expect(canvas().getByText("Docs Keeper")).toBeInTheDocument();
    expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toBeInTheDocument();
    expect(canvas().getByRole("button", { name: /^Session Codex 01/ })).toBeInTheDocument();
    // A reference the catalog has forgotten stays visible rather than silently thinning the list.
    expect(canvas().getByText("sid-gone")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-feed")).toBeNull();

    // A row opens where it sits rather than navigating: the canvas stays up, and the whole session
    // takes a bounded box inside the card -- not a transcript, a session, with the composer it is
    // typed into.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Codex 01/ }));
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    expect(screen.getByRole("region", { name: /^Session Codex 01 session/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Codex composer text")).toBeInTheDocument();
    // The open row is the session's titlebar, so the feed's controls have somewhere to portal
    // after all -- the card's own row rather than the app's header.
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-controls-host", "attached");

    // As many as the reader opens: another Bot's session joins the first rather than replacing it,
    // which is what a canvas is for. The budget that used to force one at a time is Chrome's
    // hundred streams per origin, about thirty cards away.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(
      screen.getAllByTestId("activity-feed").map((feed) => feed.getAttribute("data-session-id")),
    ).toEqual(["sid-claude-01", "sid-codex-01"]);

    // And each row closes only itself, rather than the click being the only way to swap which one
    // is up.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    fireEvent.click(canvas().getByRole("button", { name: /^Session Codex 01/ }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    unmount();
  });

  // Two open sessions each portalled their tasks panel into ONE node the app owned, and the panel
  // is absolutely placed -- so both landed at the same coordinates, stacked, with nothing saying
  // which session either belonged to. Each card carries its own now.
  it("puts each session's tasks panel inside that session's own card", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    deliverTwoBots(transport);
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    fireEvent.click(canvas().getByRole("button", { name: /^Session Codex 01/ }));
    deliverRunningTask(transport, "sid-claude-01");
    deliverRunningTask(transport, "sid-codex-01");

    const chips = screen.getAllByTestId("running-tasks-chip");
    expect(chips).toHaveLength(2);
    for (const chip of chips) fireEvent.click(chip);

    // One panel per session, and each inside the card whose session it is about. Landing in one
    // shared host put both in the same place instead, which is the bug this pins.
    // The session's whole card, which is what the panel is positioned against and what has to
    // contain it: one shared host put both panels outside either card, on the app itself.
    const card = (name: RegExp) =>
      screen.getByRole("region", { name }).closest("li") as HTMLElement;
    const panels = screen.getAllByTestId("tasks-column");
    expect(panels).toHaveLength(2);
    expect(panels.filter((panel) => card(/^Session Claude 01 session/).contains(panel)))
      .toHaveLength(1);
    expect(panels.filter((panel) => card(/^Session Codex 01 session/).contains(panel)))
      .toHaveLength(1);
    unmount();
  });

  // One error string was handed to every open session, so a failure that happened to ONE of them
  // was painted on all of them and named none of them.
  it("shows a failed detach on that session's band and no other", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    deliverTwoBots(transport);
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    fireEvent.click(canvas().getByRole("button", { name: /^Session Codex 01/ }));

    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 500,
      body: JSON.stringify({
        error: { code: "detach-failed", message: "the Bot would not let go" },
      }),
    });
    await act(async () => {
      fireEvent.click(
        canvas().getByRole("button", { name: "Actions for Session Claude 01" }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));
    });

    // On the card whose session the detach was about, and on no other. One string handed to
    // every open session said it as many times as the reader had sessions open, and named none.
    const card = (name: RegExp) =>
      screen.getByRole("region", { name }).closest("li") as HTMLElement;
    expect(within(card(/^Session Claude 01 session/)).getByRole("alert"))
      .toHaveTextContent("would not let go");
    expect(within(card(/^Session Codex 01 session/)).queryByRole("alert")).toBeNull();
    unmount();
  });

  it("reopens the canvas card that was open before a reload", () => {
    const openOneBot = () => {
      const harness = setup();
      deliverProjects(harness.transport);
      deliverSessions(harness.transport);
      fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
      act(() => {
        harness.transport.deliver("/api/bots/stream", {
          version: 2,
          revision: 1,
          bots: [
            {
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
            },
          ],
        });
      });
      return harness;
    };

    const first = openOneBot();
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    first.unmount();

    // A reload throws away every piece of React state, and this panel is edited while it is being
    // read. Coming back to a canvas of collapsed rosters means clicking back to what you were
    // reading after every save.
    const second = openOneBot();
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");

    // Closing it is remembered too, so the card does not come back after being deliberately shut.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    second.unmount();
    const third = openOneBot();
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    third.unmount();
  });

});
