/**
 * Taking things off the canvas, putting them back, and the order they stand in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, within } from "@testing-library/react";
import { CLOSED_SESSION_WIDTH } from "@/features/bots/cards/botCanvasCards";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import {
  BOT_WITH_ONE_SESSION,
  FIXTURE_PROJECT_A,
  FIXTURE_SESSIONS,
  deliverProjects,
  deliverSessions,
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
  it("says a card is empty because its sessions were taken off the canvas, not because it has none", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from canvas" }));
    });

    // "No sessions attached" would be false, and would send the reader to Add sessions for a
    // session the Bot already has.
    expect(canvas().getByText("Its session is off the canvas")).toBeInTheDocument();
    expect(canvas().queryByText("No sessions attached")).toBeNull();
    // The Bot's own header stays, which is the only way back to a Bot that was merely tidied.
    expect(canvas().getByRole("button", { name: "Add sessions to Release Captain" })).toBeInTheDocument();
    unmount();
  });

  it("brings back the canvas the reader tidied, from the Bots' records rather than this browser", async () => {
    // Both removals used to be in-memory only, so every reload -- and a Vite save is a reload --
    // undid the tidying. Then they were kept in this browser, so the phone and the Mac disagreed.
    // They are on the Bot's record now, so a reload is handed them by the sidecar.
    const evalBot = {
      ...BOT_WITH_ONE_SESSION,
      botId: "bot-2",
      name: "Eval Bot",
      sessionRefs: [],
      sessions: [],
    };
    const deliver = (transport: FakeHttpTransport, snapshot: unknown) => {
      act(() => {
        transport.deliver("/api/bots/stream", snapshot);
      });
    };

    const first = setup();
    deliverProjects(first.transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    deliver(first.transport, { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION, evalBot] });

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Eval Bot" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from canvas" }));
    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from canvas" }));
    });
    expect(screen.getByText("1 bot on the canvas")).toBeInTheDocument();
    first.unmount();

    // What the sidecar now holds, and nothing in this browser says so.
    const held = first.bots.latest()!;
    expect(held.bots.find((bot) => bot.botId === "bot-2")?.offCanvas).toBe(true);
    expect(held.bots.find((bot) => bot.botId === "bot-1")?.offCanvasSessionRefs).toEqual([
      { source: "claude", sessionId: "sid-claude-01" },
    ]);
    expect(Object.keys(localStorage).filter((key) => key.includes("off-canvas"))).toEqual([]);

    // A reload: new app, and the bots arrive from the stream as the sidecar now holds them.
    const second = setup();
    deliverProjects(second.transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    deliver(second.transport, held);

    expect(screen.getByText("1 bot on the canvas")).toBeInTheDocument();
    expect(canvas().queryByRole("button", { name: "Add sessions to Eval Bot" })).toBeNull();
    expect(canvas().getByText("Its session is off the canvas")).toBeInTheDocument();

    // And the way back is the same click it was before the reload, at both levels.
    const roster = () => within(screen.getByRole("list", { name: "Bots" }));
    fireEvent.click(roster().getByRole("button", { name: "Put Eval Bot on the canvas" }));
    fireEvent.click(roster().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.getByText("2 bots on the canvas")).toBeInTheDocument();
    expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toBeInTheDocument();
    // Restoring writes to the record as hiding did, so the next reload is not the old canvas again.
    const restored = second.bots.latest()!;
    expect(restored.bots.some((bot) => bot.offCanvas || bot.offCanvasSessionRefs)).toBe(false);
    second.unmount();
  });

  it("forgets an open card whose session no Bot holds, and keeps one the sidecar merely cannot read", () => {
    // An open key is an address nothing resolved, so one pointing at a session that has left its
    // Bot opened nothing, was invisible for exactly that reason, and stayed in the store for good.
    localStorage.setItem(
      "agent-panel.bot-canvas.open-session",
      JSON.stringify(["claude:sid-claude-01", "codex:sid-codex-01", "claude:sid-gone"]),
    );
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [
          {
            ...BOT_WITH_ONE_SESSION,
            sessionRefs: [
              { source: "claude", sessionId: "sid-claude-01" },
              // Held by the Bot, but not resolving right now, so its card is not on the canvas.
              { source: "codex", sessionId: "sid-codex-01" },
            ],
            sessions: [FIXTURE_SESSIONS[0]!],
            missingSessionRefs: [{ source: "codex", sessionId: "sid-codex-01" }],
          },
        ],
      });
    });

    // The reference the Bot no longer holds is gone; the one it holds but cannot read is kept, so
    // a session the sidecar recovers comes back open rather than collapsed.
    expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.open-session")!).sort()).toEqual([
      "claude:sid-claude-01",
      "codex:sid-codex-01",
    ]);
    unmount();
  });

  it("keeps every open card when no roster has arrived, because an empty list is not an answer", () => {
    // Two ways to have no Bots to check against, and neither may throw the canvas away: `loading`
    // goes false on a stream FAILURE as well as on a snapshot, and a snapshot itself arrives before
    // the Bots are in it. Either one pruned would forget the whole canvas when the sidecar blinked.
    localStorage.setItem("agent-panel.bot-canvas.open-session", JSON.stringify(["claude:sid-claude-01"]));
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.fail("/api/bots/stream", "sidecar is restarting");
    });

    expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.open-session")!)).toEqual(["claude:sid-claude-01"]);
    unmount();
  });

  it("opens a session picked in the canvas roster on the canvas, and scrolls its card to it", () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      const { transport, unmount } = setup();
      deliverProjects(transport);
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

      const roster = within(screen.getByRole("list", { name: "Bots" }));
      scrollIntoView.mockClear();
      scrolled.length = 0;
      fireEvent.click(roster.getByRole("button", { name: /^Session Claude 01/ }));

      // On the canvas, not instead of it: the roster is still up and the card unfolded in place.
      expect(screen.getByRole("list", { name: "Bot canvas" })).toBeInTheDocument();
      expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");

      // And the card came to the reader, because in a tiled roster it can be anywhere.
      const card = canvas()
        .getByRole("button", { name: /^Session Claude 01/ })
        .closest("li")!
        .closest("ul")!
        .closest("li");
      expect(scrolled).toContain(card);

      // The roster marks the row that is open, which is what "selected" means on this tab.
      expect(roster.getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute("aria-current", "page");
      unmount();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("says an empty canvas is empty because its Bots were taken off it, not because there are none", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
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
            sessionRefs: [],
            metadata: { labels: [], custom: {} },
            grants: [],
            createdAt: 1,
            createdBy: { kind: "user" },
            environmentAvailability: "available",
            sessions: [],
            missingSessionRefs: [],
          },
        ],
      });
    });

    // The canvas starts whole every visit, because nothing about the arrangement is stored.
    expect(canvas().getByRole("button", { name: "Add sessions to Release Captain" })).toBeInTheDocument();
    expect(screen.getByText("1 bot on the canvas")).toBeInTheDocument();

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Release Captain" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from canvas" }));

    expect(screen.getByText(/No Bots on the canvas/)).toBeInTheDocument();
    expect(screen.queryByText("No bots yet")).toBeNull();
    expect(screen.getByText("0 bots on the canvas")).toBeInTheDocument();
    unmount();
  });

  it("never pins a card to the panel's width, however narrow the panel is", () => {
    localStorage.setItem(
      "agent-panel.bot-canvas.session-sizes",
      JSON.stringify({ "claude:sid-claude-01": { width: 900, height: 500 } }),
    );
    const { transport, unmount } = setup();
    deliverProjects(transport);
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

    const card = document.querySelector<HTMLElement>('ul[aria-label="Bot canvas"] > li');
    // A Bot card is as wide as what is in it, at every panel width. It used to take the panel's
    // width below two cards' worth of room, which is what a phone got.
    expect(card!.style.width).toBe("");
    expect(card!.style.minWidth).toBe("");

    // The regression that pinning caused, and the reason this is asserted rather than left to the
    // card above: a session row is `shrink-0` in a flex row and holds a `flex-1 min-w-0` column, so
    // taking its width away resolved it to ZERO. A phone showed an empty card with a sliver in it.
    const sessions = (): HTMLElement =>
      card!.querySelector<HTMLElement>('ul[aria-label="Release Captain sessions"] > li')!;
    // The constant rather than its value: what this pins is that a closed session gets a DEFINITE
    // width, not which one. The number moves whenever something fixed-width joins the spine.
    expect(sessions().style.width).toBe(`${CLOSED_SESSION_WIDTH}px`);

    // Opened, the width it was stored at -- which the panel does not get a say in either, and which
    // now has a grip, because there is a width to drag.
    fireEvent.click(within(card!).getByRole("button", { name: /^Session Claude 01/ }));
    expect(sessions().style.width).toBe("900px");
    expect(screen.getByRole("separator", { name: /^Resize Session Claude 01.* session$/ })).toBeInTheDocument();
    unmount();
  });

  it("reorders the strip from a card's menu, and stands the Bots that way again after a reload", () => {
    const { transport, unmount, bots } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    const deliver = () =>
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
              metadata: { labels: [], custom: {} },
              grants: [],
              createdAt: 1,
              createdBy: { kind: "user" },
              environmentAvailability: "available",
              sessions: [FIXTURE_SESSIONS[0]!],
              missingSessionRefs: [],
            },
            {
              botId: "bot-2",
              name: "Nightly Sweeper",
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
    deliver();

    // Read off each card's own session list, which is labelled with its Bot. The name in the header
    // is not a usable handle: the avatar beside it carries the Bot's initials in the same span.
    const standing = () =>
      [...document.querySelectorAll('ul[aria-label="Bot canvas"] > li')].map(
        (card) => card.querySelector('ul[aria-label$=" sessions"]')?.getAttribute("aria-label") ?? "",
      );
    expect(standing()).toEqual(["Release Captain sessions", "Nightly Sweeper sessions"]);

    // The left end offers no way further left, so the entry is absent rather than dead.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Release Captain" }));
    expect(screen.queryByRole("menuitem", { name: "Move left" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));

    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    // Written to each Bot's record, as positions, and nothing to this browser.
    expect(
      transport.requests
        .filter((request) => request.path.endsWith("/canvas"))
        .map((request) => [request.path, request.body]),
    ).toEqual([
      ["/api/bots/bot-2/canvas", { position: 0 }],
      ["/api/bots/bot-1/canvas", { position: 1 }],
    ]);
    expect(localStorage.getItem("agent-panel.bot-canvas.order")).toBeNull();

    // The roster arriving again carries the order, so it stands.
    const held = bots.latest()!;
    act(() => transport.deliver("/api/bots/stream", held));
    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    unmount();

    // A reload, which is a different browser as far as storage goes, is handed the same records.
    const second = setup();
    deliverProjects(second.transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => second.transport.deliver("/api/bots/stream", held));
    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    second.unmount();
  });

  // From the Canvas tab's Sessions view, whose rows sit beside the canvas rather than on it: the
  // card opens and scrolls itself into view, rather than the canvas searching for it afterwards.
  it("opens a session's card and scrolls to it from its row in the Sessions view", async () => {
    const scrolled: Element[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this);
    });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", { version: 2, revision: 1, bots: [BOT_WITH_ONE_SESSION] });
    });
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Canvas views" })).getByRole("tab", { name: "Sessions" }),
    );
    scrolled.length = 0;

    fireEvent.click(await screen.findByRole("button", { name: "Show Session Claude 01 on the canvas" }));

    const card = canvas().getByRole("button", { name: /^Session Claude 01/ });
    expect(card).toHaveAttribute("aria-expanded", "true");
    // The session's own card, not the Bot card around it, which can be wider than the canvas.
    expect(scrolled).toEqual([card.closest("li")]);
    unmount();
  });
});
