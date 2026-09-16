/**
 * How a canvas card is sized, and what it is sized against.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, within } from "@testing-library/react";
import {
  DEFAULT_CARD_WIDTH,
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
} from "@/features/bots/botCanvasPreferences";
import {
  BOT_WITH_ONE_SESSION,
  FIXTURE_PROJECT_A,
  FIXTURE_SESSIONS,
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

  /** The canvas's own list, so a query cannot pick up a matching row in the sidebar instead. */
  const canvas = () => within(screen.getByRole("list", { name: "Bot canvas" }));
  it("gives a canvas row the whole session, sized against the card rather than the page", () => {
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

    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));

    // Putting the row's screen above its field hands that pane the session's column to be a share
    // of. Left to ask the viewport it would open taller than the card holding it.
    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));
    expect(terminalPaneMock.composerContext).toEqual({
      kind: "session-tmux",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    expect(terminalPaneMock.composerHasBasis).toBe(true);
    // And the field is still there under it, which is what the screen standing ABOVE it means.
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide the terminal" }));

    // The thread terminal opens from the control the row lends the session, and it names the BOT's
    // directory -- the canvas has no project selection to borrow one from.
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: FIXTURE_PROJECT_A.projectPath,
      source: "claude",
      sessionId: "sid-claude-01",
    });

    // Closing the row ends all of it rather than hiding it, which is what keeps one open session
    // affordable on a roster of thirty.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    expect(screen.queryByLabelText("Claude composer text")).toBeNull();
    expect(screen.queryByRole("region", { name: "Claude terminal" })).toBeNull();
    unmount();
  });

  it("resizes an open session on both axes, and gives its Bot card no size of its own", () => {
    localStorage.setItem(
      "agent-panel.bot-canvas.session-sizes",
      JSON.stringify({ "claude:sid-claude-01": { width: DEFAULT_CARD_WIDTH, height: 900 } }),
    );
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

    // A card has a width whether or not you are reading it, so this one is there from the start --
    // while its height is not, because a closed card is as tall as its own rows and a height forced
    // on it would be empty space.
    // The Bot card has no size of its own in either direction -- it is exactly as big as the
    // sessions standing in it -- so neither of its old grips is there to find.
    expect(screen.queryByRole("separator", { name: /Release Captain/ })).toBeNull();

    // Nor has a closed session: it is a spine at a width nobody chose, and a width set on it would
    // be the one you found on opening it.
    expect(screen.queryByRole("separator", { name: /Session Claude 01/ })).toBeNull();

    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    const grip = screen.getByRole("separator", { name: /^Resize Session Claude 01.* session$/ });
    const widenSession = screen.getByRole("separator", { name: /^Widen Session Claude 01/ });
    // The remembered 900, untouched by the 768px-tall window it is being shown in: a card is free
    // to be taller than the screen, because the canvas scrolls.
    expect(grip).toHaveAttribute("aria-valuenow", "900");
    expect(grip).toHaveAttribute("aria-valuemax", String(MAX_CARD_HEIGHT));

    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuenow", "876");

    // Home is the floor rather than nothing: below it the grip is inside a card too short to show
    // it, and the drag could not be undone by pointer.
    fireEvent.keyDown(grip, { key: "Home" });
    expect(grip).toHaveAttribute("aria-valuenow", String(MIN_CARD_HEIGHT));

    // The corner moves both at once, which is the only thing a keyboard cannot express. It carries
    // no name, so it is found the way a pointer finds it: by its tooltip.
    const corner = document.querySelector<HTMLElement>('[title="Resize both ways"]');
    expect(corner).not.toBeNull();
    fireEvent.pointerDown(corner!, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(corner!, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(corner!, { pointerId: 1, clientX: 40, clientY: 40 });
    expect(widenSession).toHaveAttribute("aria-valuenow", String(DEFAULT_CARD_WIDTH + 40));
    expect(grip).toHaveAttribute("aria-valuenow", String(MIN_CARD_HEIGHT + 40));

    expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.session-sizes") ?? "{}")).toEqual({
      "claude:sid-claude-01": { width: DEFAULT_CARD_WIDTH + 40, height: MIN_CARD_HEIGHT + 40 },
    });

    // Closing puts it back to a spine and takes both grips with it, but the size it was given is
    // kept: it is the width it opens at next time.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.queryByRole("separator", { name: /Session Claude 01/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.session-sizes") ?? "{}")).toEqual({
      "claude:sid-claude-01": { width: DEFAULT_CARD_WIDTH + 40, height: MIN_CARD_HEIGHT + 40 },
    });

    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.getByRole("separator", { name: /^Widen Session Claude 01/ })).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_CARD_WIDTH + 40),
    );
    unmount();
  });

  it("takes a whole Bot off the canvas and puts it back from the sidebar roster", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    const bot = (botId: string, name: string) => ({
      botId,
      name,
      environment: { kind: "directory" as const, path: FIXTURE_PROJECT_A.projectPath },
      sessionRefs: [],
      metadata: { labels: [], custom: {} },
      grants: [],
      createdAt: 1,
      createdBy: { kind: "user" as const },
      environmentAvailability: "available" as const,
      sessions: [],
      missingSessionRefs: [],
    });
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [bot("bot-1", "Release Captain"), bot("bot-2", "Eval Bot")],
      });
    });
    expect(screen.getByText("2 bots on the canvas")).toBeInTheDocument();

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Release Captain" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from canvas" }));

    // Gone from the canvas, and the count agrees.
    expect(screen.queryByRole("region", { name: "Release Captain sessions" })).toBeNull();
    expect(canvas().queryByRole("button", { name: "Add sessions to Release Captain" })).toBeNull();
    expect(canvas().getByRole("button", { name: "Add sessions to Eval Bot" })).toBeInTheDocument();
    expect(screen.getByText("1 bot on the canvas")).toBeInTheDocument();

    // The Bot did not move anywhere. It is in the same roster row it was always in -- the full
    // Bots list, with its sessions and its own buttons -- no longer marked as on the canvas, and
    // that row is the way back.
    const roster = within(screen.getByRole("list", { name: "Bots" }));
    expect(roster.getByRole("button", { name: "Put Release Captain on the canvas" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(roster.getByRole("button", { name: "Take Eval Bot off the canvas" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(roster.getByRole("button", { name: "Put Release Captain on the canvas" }));
    expect(canvas().getByRole("button", { name: "Add sessions to Release Captain" })).toBeInTheDocument();
    expect(screen.getByText("2 bots on the canvas")).toBeInTheDocument();
    unmount();
  });

  it("takes one session off the canvas without touching the Bot, and puts it back from the roster", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const { transport, unmount } = setup();
      deliverProjects(transport);
      fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
      act(() => {
        transport.deliver("/api/bots/stream", {
          version: 2,
          revision: 1,
          bots: [{
            ...BOT_WITH_ONE_SESSION,
            sessionRefs: [
              { source: "claude", sessionId: "sid-claude-01" },
              { source: "codex", sessionId: "sid-codex-01" },
            ],
            sessions: FIXTURE_SESSIONS,
          }],
        });
      });
      expect(screen.getByText("2 sessions, 1 live")).toBeInTheDocument();

      fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
      // Below the Bot-level removal, because it is the smaller of the two and the one that is
      // undone by a click rather than by a request.
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "Rename session",
        "Fork session",
        "Fork from last message",
        "Fork from last compaction",
        // One direction only: this is the first of the Bot's two sessions, so there is nowhere
        // earlier for it to go and the entry that would say so is absent rather than inert.
        "Move right",
        "Remove from bot",
        "Remove from canvas",
      ]);
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove from canvas" }));
      });

      // The card is gone and the Bot is untouched: nothing was asked of the sidecar, and the
      // count says where the missing session went rather than pretending it was never there.
      expect(canvas().queryByRole("button", { name: /^Session Claude 01/ })).toBeNull();
      expect(canvas().getByRole("button", { name: /^Session Codex 01/ })).toBeInTheDocument();
      expect(transport.requests.some((request) => request.path.endsWith("/sessions/detach"))).toBe(false);
      expect(screen.getByText("1 session, 1 off the canvas")).toBeInTheDocument();

      // Still in the roster, dimmed rather than dropped, and clicking it is the way back.
      const roster = within(screen.getByRole("list", { name: "Bots" }));
      const row = roster.getByRole("button", { name: /^Session Claude 01/ });
      expect(row).toHaveAttribute("title", "Off the canvas");
      fireEvent.click(row);
      expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText("2 sessions, 1 live")).toBeInTheDocument();
      unmount();
    } finally {
      scrollIntoView.mockRestore();
    }
  });


  it("adds nothing to the canvas until the zoom mode is asked for, and remembers being asked", () => {
    // The guarantee the whole mode rests on. Off is not `scale(1)` and not a neutral wrapper: the
    // transform node and the sizer do not exist, so the strip keeps the pointer arithmetic and the
    // `position: fixed` semantics it has today, and abandoning the mode is deleting one branch.
    //
    // What this canNOT check is the mode drawing: jsdom measures nothing, so the hook never learns
    // a size and never produces a scale. That half is `just canvas-zoom-verify`, in a browser that
    // lays pages out. What is worth pinning here is the absence, and that the toggle is wired.
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          ...BOT_WITH_ONE_SESSION,
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          sessions: [FIXTURE_SESSIONS[0]!],
        }],
      });
    });

    const strip = screen.getByRole("list", { name: "Bot canvas" });
    const sizer = strip.parentElement!;
    const scroller = sizer.parentElement!;
    // Read off the style ATTRIBUTE rather than the property, which is the stronger claim and also
    // the only one jsdom can answer: its CSS model implements no `touch-action`, so the property
    // reads undefined whether or not anything set it. Nothing written at all is what is meant.
    expect(strip).not.toHaveAttribute("style");
    expect(strip).not.toHaveAttribute("inert");
    expect(scroller).not.toHaveAttribute("style");
    expect(scroller.className).toContain("overflow-auto");
    // The wrapper is always in the tree and generates no box while the mode is off, which is what
    // lets it appear without moving the strip. Moving the strip would remount it, and with it
    // every open session card -- so this assertion is about live streams, not about layout.
    expect(sizer).toHaveAttribute("style", "display: contents;");
    expect(sizer).not.toHaveAttribute("class");

    const fit = screen.getByRole("button", { name: "Fit the whole canvas" });
    expect(fit).toHaveAttribute("aria-pressed", "false");
    act(() => fireEvent.click(fit));
    expect(screen.getByRole("button", { name: "Fit the whole canvas" }))
      .toHaveAttribute("aria-pressed", "true");
    // Stored, because this panel is edited while it is read and a reload happens many times an
    // hour. A mode that forgot would be one the reader re-enters all day.
    expect(localStorage.getItem("agent-panel.bot-canvas.zoom-mode")).toBe("on");

    act(() => fireEvent.click(screen.getByRole("button", { name: "Fit the whole canvas" })));
    expect(localStorage.getItem("agent-panel.bot-canvas.zoom-mode")).toBeNull();
    unmount();
  });

});
