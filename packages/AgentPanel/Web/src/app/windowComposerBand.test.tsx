/**
 * The band the window composer renders into, and the meter beside it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import {
  COMPOSER_STREAM,
  createPiSession,
  deliverProjects,
  deliverSessions,
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
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("Claude window composer field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  /**
   * Focuses the Claude field, which is what opens the composer stream: the watch is focus-gated.
   *
   * Claude's composer is served by the sidecar now (ADR-0110), so the seam these tests drive is the
   * HTTP transport rather than the host bridge. Codex still uses the lane, which is why the Codex
   * test below still asserts on `fake.posted`.
   */
  function focusComposer(_transport: FakeHttpTransport) {
    const field = screen.getByLabelText("Claude composer text");
    fireEvent.focus(field);
    return { field };
  }

  /** One status frame on the composer stream. The short keys are the test's, not the wire's. */
  function deliverStatus(transport: FakeHttpTransport, overrides: Record<string, unknown> = {}) {
    const { en = true, cur = true, tx = "", r = null, sid = "sid-claude-01" } = overrides;
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: sid,
          enabled: en,
          reason: r,
          onActiveDesktop: cur,
          composerText: tx,
        },
      });
    });
  }

  /** Every composer command of one kind the panel issued, in order. */
  function composerCalls(transport: FakeHttpTransport, kind: "sync" | "submit" | "read") {
    return transport.requests.filter((request) => request.path === `/api/window/composer/${kind}`);
  }

  /** The body of the last composer command of one kind, for a `toMatchObject` on what was sent. */
  function lastComposerCall(transport: FakeHttpTransport, kind: "sync" | "submit" | "read") {
    return composerCalls(transport, kind).at(-1)?.body;
  }

  /**
   * Pre-seeds what a composer command answers.
   *
   * Seeded BEFORE the action rather than delivered after it, because a POST resolves its own
   * promise: there is no correlation id to answer late against, which is most of why this path is
   * simpler than the lane it replaced.
   */
  function answerComposer(
    transport: FakeHttpTransport,
    kind: "sync" | "submit" | "read",
    body: unknown,
    status = 200,
  ) {
    transport.responses.set(`POST /api/window/composer/${kind}`, {
      status,
      body: JSON.stringify(body),
    });
  }
  it("renders the shared band for Codex through the window composer", () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByText("Session Codex 01"));

    // The composer UI is shared across sources, so Codex gets the same window
    // band Claude gets: focusing subscribes the watch, the status prefills the
    // field, and the explicit action is the Enter button that commits the
    // prompt in the Codex window.
    const field = screen.getByLabelText("Codex composer text");
    expect(field).not.toBeDisabled();
    fireEvent.focus(field);
    // The stream names its source, because the sidecar runs a different resolver for each and a
    // silently wrong default would report "not running" for a window in front of the user.
    expect(transport.subscriptions.some((open) => open.path.includes("source=codex"))).toBe(true);
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: "sid-codex-01",
          enabled: true,
          reason: null,
          onActiveDesktop: true,
          composerText: "existing codex draft",
        },
      });
    });
    expect(field).toHaveValue("existing codex draft");
    expect(screen.getByLabelText("Send to Codex's composer")).not.toBeDisabled();
    unmount();
  });

  it("does not send Codex on the off-Desktop round trip: its reads are always free", () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByText("Session Codex 01"));

    // Codex Desktop materializes trees for every window on every Desktop, so the watch status always
    // carries the composer text -- the status IS the free read. Claude's one automatic
    // bring-and-move-back must not fire here even when the window sits on another Desktop.
    const field = screen.getByLabelText("Codex composer text");
    fireEvent.focus(field);
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: "sid-codex-01",
          enabled: true,
          reason: null,
          onActiveDesktop: false,
          composerText: "already readable",
        },
      });
    });

    expect(field).toHaveValue("already readable");
    expect(
      composerCalls(transport, "read"),
    ).toHaveLength(0);
    unmount();
  });

  it("renders the composer as a roomy, padded field rather than a single cramped row", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    focusComposer(transport);

    deliverStatus(transport, { tx: "" });

    const field = screen.getByLabelText("Claude composer text");
    // The band's gutter is a share of its column, the same expression the transcript above it
    // uses, or the two would disagree about where the text begins. A window this wide is past the
    // 24px cap, which is what this view has always had.
    expect(screen.getByLabelText("Claude window composer").className)
      .toContain("px-[clamp(0.75rem,3%,1.5rem)]");
    // The resting height and padding are the load-bearing part of the redesign: a multi-line draft
    // must have room to breathe before it even begins to grow. `min-h-12` (a two-line resting field)
    // and the `pl-4 py-3` gutter are the contract (the right side holds the send); the auto-grow
    // cap stops the field from chasing a wall of text forever.
    expect(field.className).toContain("min-h-12");
    expect(field.className).toContain("pl-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    // The ring is on the box around the field rather than the field itself, because the box also
    // holds the images the composer is carrying and they are inside the same border.
    expect(field.parentElement?.parentElement?.className).toContain("focus-within:ring-2");
    unmount();
  });

  it("shows the context meter below the composer's action row, not in the header", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    // The meter is rendered by the composer band, which exists for every source;
    // the shell's header keeps only the feed's own controls.
    const meter = await waitFor(() =>
      within(screen.getByLabelText("Claude window composer")).getByRole("progressbar", {
        name: "Context: 75% of 200,000 tokens",
      }),
    );
    expect(meter).toBeInTheDocument();
    expect(within(screen.getByRole("banner")).queryByRole("progressbar")).toBeNull();
    unmount();
  });

  it("shows the context meter in the Pi composer band as well", async () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    await createPiSession(transport);

    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Agent prompt")).getByRole("progressbar", {
          name: "Context: 75% of 200,000 tokens",
        }),
      ).toBeInTheDocument(),
    );
    unmount();
  });
});
