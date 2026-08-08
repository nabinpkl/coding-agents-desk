/**
 * Render tests for the webview App shell.
 *
 * These tests use a FakeHostBridge to drive the BridgeDataSource and assert
 * shell behavior: project expansion streams session previews, selecting a session
 * mounts the thread view, and the project tree remains available beside it.
 *
 * ActivityFeed is mocked (it's a heavy virtualized component that depends on
 * ProseMirror/Milkdown) -- we assert that it is mounted and that the bridge
 * received an agent-thread-sub message, which is the behavioral signal that the
 * data layer wired up correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { BridgeDataSource } from "../features/activity-feed/data-source/BridgeDataSource";
import { FakeHostBridge } from "../features/activity-feed/data-source/HostBridge";
import { storeSidebarPreferences } from "../features/sidebar/sidebarPreferences";
import { App } from "./AgentPanelApp";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock ActivityFeed so Milkdown/ProseMirror never loads in jsdom.
vi.mock("../features/activity-feed/ActivityFeed", async () => {
  const { useEffect } = await import("react");
  // A fixed occupancy report so tests can assert the context meter: 150k of a
  // 200k window is 75%.
  const FIXED_USAGE = { current: 150_000, limit: 200_000, updatedAt: 1, model: "claude-opus-5" };
  return {
    ActivityFeed: ({
      source,
      sessionId,
      controlsHost,
      onUsage,
      onOpenQuestion,
    }: {
      source: string;
      sessionId: string;
      controlsHost: HTMLElement | null;
      onUsage?: (usage: unknown) => void;
      onOpenQuestion?: (question: unknown) => void;
    }) => {
      useEffect(() => {
        onUsage?.(FIXED_USAGE);
      }, [onUsage, sessionId]);
      // The real feed mirrors its open AskUserQuestion up; the mock exposes a
      // hoisted emitter so tests can drive the mirror through the same seam.
      useEffect(() => {
        feedMock.emitQuestion = (question: unknown) => onOpenQuestion?.(question);
        return () => {
          feedMock.emitQuestion = null;
        };
      }, [onOpenQuestion, sessionId]);
      return (
        <div
          data-testid="activity-feed"
          data-source={source}
          data-session-id={sessionId}
          // The feed portals its fold control into the shell's header instead of
          // spending a band of its own on it, so the host node is part of the
          // contract between them.
          data-controls-host={controlsHost ? "attached" : "missing"}
        >
          Thread for {sessionId}
        </div>
      );
    },
  };
});

// Shared, hoisted state between the mocked feed and the tests: the tests set the
// feed's open question through this emitter, exactly as the real feed reports it.
const feedMock = vi.hoisted(() => ({
  emitQuestion: null as ((question: unknown) => void) | null,
}));

// Mock the Markdown renderer (used by ActivityFeed; mocked so its
// marked/shiki/katex deps never load under jsdom if pulled in transitively).
vi.mock("../features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-view">{content}</div>
  ),
}));

// Mock DiffBlock (uses next-themes and @git-diff-view which don't run in jsdom).
vi.mock("../features/activity-feed/DiffBlock", () => ({
  DiffBlock: () => <div data-testid="diff-block" />,
}));

// ---------------------------------------------------------------------------
// Fixture project data
// ---------------------------------------------------------------------------

// Abbreviated wire shape (matches SharedTypes.swift / BridgeDataSource wire layer).
const FIXTURE_PROJECT_A = {
  pp: "/projects/alpha",
  dn: "Alpha Project",
  sc: { claude: 1, codex: 1 },
  sn: 2,
  lea: Date.now() - 10_000,
};

const FIXTURE_PROJECT_B = {
  pp: "/projects/beta",
  dn: "Beta Project",
  sc: { claude: 1, codex: 0 },
  sn: 1,
  lea: Date.now() - 5_000,
};

const FIXTURE_PROJECTS = [FIXTURE_PROJECT_A, FIXTURE_PROJECT_B];
const READ_ONLY_CAPABILITIES = {
  md: ["raw", "nice"],
  snd: false,
  str: false,
  abt: false,
  raw: true,
  pty: true,
  xui: false,
};
const FIXTURE_SESSIONS = [
  {
    sid: "sid-claude-01",
    src: "claude" as const,
    ttl: "Session Claude 01",
    lea: Date.now() - 10_000,
    ac: "live" as const,
    cap: READ_ONLY_CAPABILITIES,
  },
  {
    sid: "sid-codex-01",
    src: "codex" as const,
    ttl: "Session Codex 01",
    lea: Date.now() - 60_000,
    ac: "ready" as const,
    cap: READ_ONLY_CAPABILITIES,
  },
];

const originalMatchMedia = globalThis.matchMedia;

function installViewport({
  compact,
  hoverCapable,
}: {
  compact: boolean;
  hoverCapable: boolean;
}) {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (queryText: string) => ({
      matches: queryText.includes("max-width") ? compact : hoverCapable,
      media: queryText,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }) as MediaQueryList,
  });
}

function restoreViewport() {
  if (originalMatchMedia) {
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    Reflect.deleteProperty(globalThis, "matchMedia");
  }
}

function firePointerEvent(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  { pointerId, clientX }: { pointerId: number; clientX: number },
) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const fake = new FakeHostBridge();
  let sequence = 0;
  const bridge = new BridgeDataSource(fake, {
    requestIDFactory: (prefix) =>
      prefix === "terminal" ? "request-1" : `${prefix}-${++sequence}`,
  });
  const { unmount } = render(<App bridge={bridge} />);
  return { fake, bridge, unmount };
}

function latestSubscription(fake: FakeHostBridge, type: string): string {
  const message = [...fake.posted]
    .reverse()
    .find((candidate) => (candidate as { t?: string }).t === type) as
    | { sub?: string }
    | undefined;
  if (!message?.sub) throw new Error(`missing ${type}`);
  return message.sub;
}

function deliverProjects(fake: FakeHostBridge) {
  const sub = latestSubscription(fake, "agent-projects-watch");
  act(() => {
    fake.deliver({ t: "agent-projects", sub, p: FIXTURE_PROJECTS });
  });
}

function deliverSessions(fake: FakeHostBridge) {
  deliverProjectSessions(fake, FIXTURE_PROJECT_A.pp, FIXTURE_SESSIONS);
}

function latestProjectSessionsSubscription(fake: FakeHostBridge, projectPath: string): string {
  const message = [...fake.posted]
    .reverse()
    .find((candidate) => {
      const wire = candidate as { t?: string; pp?: string };
      return wire.t === "agent-project-sessions-watch" && wire.pp === projectPath;
    }) as { sub?: string } | undefined;
  if (!message?.sub) throw new Error(`missing session subscription for ${projectPath}`);
  return message.sub;
}

function deliverProjectSessions(
  fake: FakeHostBridge,
  projectPath: string,
  sessions: typeof FIXTURE_SESSIONS | Array<Record<string, unknown>>,
) {
  const sub = latestProjectSessionsSubscription(fake, projectPath);
  act(() => {
    fake.deliver({
      t: "agent-project-sessions",
      sub,
      pp: projectPath,
      ss: sessions,
    });
  });
}

function openClaudeThread(fake: FakeHostBridge) {
  deliverProjects(fake);
  deliverSessions(fake);
  fireEvent.click(screen.getByText("Session Claude 01"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  it("renders the project list title on mount", () => {
    const { unmount } = setup();
    expect(screen.getByText("Agent Feed")).toBeInTheDocument();
    unmount();
  });

  it("gives the titlebar inset to the header at the window's leading edge", () => {
    const { unmount } = setup();
    const projectsHeader = screen.getByRole("heading", { level: 2, name: "Projects" }).parentElement;
    const threadHeader = screen.getByRole("banner");

    expect(projectsHeader).toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(threadHeader).not.toHaveClass("agent-window-titlebar-main-leading");

    fireEvent.click(screen.getByRole("button", { name: "Close projects" }));
    expect(screen.queryByRole("heading", { level: 2, name: "Projects" })).not.toBeInTheDocument();
    expect(threadHeader).toHaveClass("agent-window-titlebar-main-leading");
    expect(
      screen.getByRole("button", { name: "Pin projects sidebar" })
        .querySelector(".lucide-panel-left"),
    ).not.toBeNull();
    unmount();
  });

  it("shows loading before the first project snapshot", () => {
    const { unmount } = setup();
    expect(screen.getByText(/loading projects/i)).toBeInTheDocument();
    unmount();
  });

  it("renders fed projects with their source badges and session counts", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

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
    const { fake, unmount } = setup();
    deliverProjects(fake);

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "false");
    expect(fake.posted).toContainEqual(expect.objectContaining({
      t: "agent-project-sessions-watch",
      pp: FIXTURE_PROJECT_A.pp,
    }));

    deliverSessions(fake);
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Session Codex 01")).toBeInTheDocument();
    unmount();
  });

  it("keeps several projects expanded with independent subscriptions", () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);

    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));
    deliverProjectSessions(fake, FIXTURE_PROJECT_B.pp, [{
      sid: "sid-beta-01",
      src: "claude",
      ttl: "Beta session",
      lea: Date.now(),
      ac: "ready",
      cap: READ_ONLY_CAPABILITIES,
    }]);

    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");

    const alphaSubscription = latestProjectSessionsSubscription(fake, FIXTURE_PROJECT_A.pp);
    fireEvent.click(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ }));
    expect(fake.posted).toContainEqual({
      t: "agent-project-sessions-unwatch",
      sub: alphaSubscription,
    });
    expect(screen.queryByText("Session Claude 01")).not.toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();

    unmount();
  });

  it("shows three sessions first and reveals ten more per click", () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    const manySessions = Array.from({ length: 24 }, (_, index) => ({
      sid: `sid-${index + 1}`,
      src: "codex",
      ttl: `Session ${String(index + 1).padStart(2, "0")}`,
      lea: Date.now() - index,
      ac: "ready",
      cap: READ_ONLY_CAPABILITIES,
    }));
    deliverProjectSessions(fake, FIXTURE_PROJECT_A.pp, manySessions);

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

    deliverProjectSessions(fake, FIXTURE_PROJECT_A.pp, manySessions.slice(0, 2));
    expect(screen.getByText("Session 02")).toBeInTheDocument();
    expect(screen.queryByText("Session 03")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show .* more/ })).not.toBeInTheDocument();

    unmount();
  });

  it("mounts the selected thread while keeping its project sessions visible", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

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
    const { fake, unmount } = setup();
    const projectSubscription = latestSubscription(fake, "agent-projects-watch");
    deliverProjects(fake);
    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));

    act(() => {
      fake.deliver({
        t: "agent-projects",
        sub: projectSubscription,
        p: [FIXTURE_PROJECT_B, FIXTURE_PROJECT_A],
      });
    });

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");
    unmount();
  });

  it("uses a modal project drawer on compact view and restores focus after dismissal", async () => {
    installViewport({ compact: true, hoverCapable: false });
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);

    const trigger = screen.getByRole("button", { name: "Open projects" });
    const drawer = screen.getByRole("dialog", { name: "Projects" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveAttribute("open");

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveAttribute("open");

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Close projects" }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent(drawer, new Event("cancel", { cancelable: true }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());
    unmount();
  });

  it("previews on desktop hover, pins on click, and restores the saved width", () => {
    vi.useFakeTimers();
    installViewport({ compact: true, hoverCapable: true });
    storeSidebarPreferences({ open: false, width: 300 });
    const first = setup();
    deliverProjects(first.fake);

    const trigger = screen.getByRole("button", { name: "Pin projects sidebar" });
    expect(screen.queryByRole("complementary", { name: "Projects preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("complementary", { name: "Projects preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Projects" }).parentElement)
      .toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 300,
    });

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("complementary", { name: "Projects preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Pin projects sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeInTheDocument();

    const separator = screen.getByRole("separator", { name: "Resize projects sidebar" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "316");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 316,
    });

    firePointerEvent(separator, "pointerdown", { pointerId: 7, clientX: 316 });
    firePointerEvent(separator, "pointermove", { pointerId: 7, clientX: 356 });
    expect(separator).toHaveAttribute("aria-valuenow", "356");
    firePointerEvent(separator, "pointerup", { pointerId: 7, clientX: 356 });
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 356,
    });

    first.unmount();
    const restored = setup();
    expect(screen.getByRole("separator", { name: "Resize projects sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "356",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close projects" }));
    expect(screen.getByRole("button", { name: "Pin projects sidebar" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 356,
    });
    restored.unmount();
    vi.useRealTimers();
  });

  it("gives the thread a header slot for its own controls", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

    expect(screen.getByTestId("activity-feed")).toHaveAttribute(
      "data-controls-host",
      "attached",
    );
    unmount();
  });

  it("drops the centring spacer so a long title uses the full row", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

    // The spacer opposite the back button existed only to centre the title, and
    // cost it 36px plus a gap -- enough to truncate real session titles.
    const heading = screen.getByRole("heading", { level: 1 });
    const header = heading.parentElement!;
    const emptySpacers = [...header.children].filter(
      (child) => child.tagName === "DIV" && child.getAttribute("aria-hidden") === "true",
    );
    expect(emptySpacers).toHaveLength(0);
    expect(heading.className).toContain("flex-1");
    unmount();
  });

  it("announces terminal progress without spending a row on it", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    // Progress and ready are carried by the header icon; the sentence is for
    // assistive tech only. A permanent 45px band for one button is what this
    // replaced.
    expect(screen.getByRole("status")).toHaveClass("sr-only");

    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "agent-resume-claude-sid-claude-01",
      });
    });
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    unmount();
  });

  it("keeps failure and exit visible, because those need reading", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    act(() => {
      fake.deliver({
        t: "agent-terminal-error",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        c: "activeElsewhere",
      });
    });
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    unmount();
  });

  it("shows the terminal launcher only on a thread", () => {
    const { fake, unmount } = setup();

    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();
    deliverProjects(fake);
    deliverSessions(fake);
    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("opens with exact context and enters loading until matching native status", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    expect(fake.posted).toContainEqual({
      t: "agent-terminal-open",
      rid: "request-1",
      ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Opening Claude");

    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "agent-resume-claude-sid-claude-01",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal ready");
    expect(screen.getByRole("button", { name: "Close Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("updates the band for matching error and ended status", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    act(() => {
      fake.deliver({
        t: "agent-terminal-error",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        c: "activeElsewhere",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal unavailable: activeElsewhere");

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    act(() => {
      fake.deliver({
        t: "agent-terminal-ended",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "agent-resume-claude-sid-claude-01",
        xs: 0,
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal ended");
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("keeps closing fenced from delayed ready and does not close twice on replacement", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "agent-resume-claude-sid-claude-01",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Claude terminal" }));
    expect(screen.getByRole("status")).toHaveTextContent("Closing Claude");
    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "agent-resume-claude-sid-claude-01",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Closing Claude");

    fireEvent.click(screen.getByText("Session Codex 01"));
    expect(
      fake.posted.filter(
        (message) => (message as { t?: string }).t === "agent-terminal-close",
      ),
    ).toHaveLength(1);
    unmount();
  });

  it("posts close then context-ended before replacing the selected thread", () => {
    const fake = new FakeHostBridge();
    const observations: boolean[] = [];
    const originalPost = fake.postToHost.bind(fake);
    fake.postToHost = (message: unknown) => {
      if ((message as { t?: string }).t === "agent-terminal-context-ended") {
        observations.push(screen.queryByTestId("activity-feed") !== null);
      }
      originalPost(message);
    };
    let sequence = 0;
    const bridge = new BridgeDataSource(fake, {
      requestIDFactory: (prefix) =>
        prefix === "terminal" ? "request-1" : `${prefix}-${++sequence}`,
    });
    const { unmount } = render(<App bridge={bridge} />);
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    fireEvent.click(screen.getByText("Session Codex 01"));

    expect(
      fake.posted.filter((message) =>
        ["agent-terminal-close", "agent-terminal-context-ended"].includes(
          (message as { t?: string }).t ?? "",
        ),
      ),
    ).toEqual([
      {
        t: "agent-terminal-close",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
      },
      {
        t: "agent-terminal-context-ended",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
      },
    ]);
    expect(observations).toEqual([true]);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    unmount();
  });

  it("ends the old request before opening a replacement session", () => {
    const ids = ["request-1", "request-2"];
    const fake = new FakeHostBridge();
    let sequence = 0;
    const bridge = new BridgeDataSource(fake, {
      requestIDFactory: (prefix) =>
        prefix === "terminal"
          ? ids.shift() ?? "unexpected"
          : `${prefix}-${++sequence}`,
    });
    const { unmount } = render(<App bridge={bridge} />);
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    const terminalMessages = fake.posted.filter((message) =>
      (message as { t?: string }).t?.startsWith("agent-terminal-"),
    );
    expect(terminalMessages).toEqual([
      expect.objectContaining({ t: "agent-terminal-open", rid: "request-1" }),
      expect.objectContaining({ t: "agent-terminal-close", rid: "request-1" }),
      expect.objectContaining({ t: "agent-terminal-context-ended", rid: "request-1" }),
      expect.objectContaining({
        t: "agent-terminal-open",
        rid: "request-2",
        ctx: { pp: "/projects/alpha", src: "codex", sid: "sid-codex-01" },
      }),
    ]);
    unmount();
  });

  it("ignores stale ready after navigation and session replacement", () => {
    const ids = ["request-1", "request-2"];
    const fake = new FakeHostBridge();
    let sequence = 0;
    const bridge = new BridgeDataSource(fake, {
      requestIDFactory: (prefix) =>
        prefix === "terminal"
          ? ids.shift() ?? "unexpected"
          : `${prefix}-${++sequence}`,
    });
    const { unmount } = render(<App bridge={bridge} />);
    openClaudeThread(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-1",
        ctx: { pp: "/projects/alpha", src: "claude", sid: "sid-claude-01" },
        psn: "stale-pty",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Opening Codex");

    act(() => {
      fake.deliver({
        t: "agent-terminal-ready",
        rid: "request-2",
        ctx: { pp: "/projects/alpha", src: "codex", sid: "sid-codex-01" },
        psn: "agent-resume-codex-sid-codex-01",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Codex terminal ready");
    unmount();
  });

  it("creates a Pi session, sends through the composer, and answers extension UI", async () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);

    fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
    const create = fake.posted.at(-1) as { rid: string };
    await act(async () => {
      fake.deliver({
        t: "agent-command-receipt",
        rid: create.rid,
        src: "pi",
        sid: "pi-1",
        del: "created",
        s: {
          sid: "pi-1",
          src: "pi",
          ttl: "SDK-authored Pi session",
          lea: 123,
          ac: "ready",
          cap: { md: ["nice"], snd: true, str: true, abt: true, raw: false, pty: false, xui: true },
        },
      });
    });

    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-source", "pi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("SDK-authored Pi session");
    expect(screen.queryByRole("button", { name: /Pi terminal/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Pi" }), { target: { value: "Inspect the repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const send = fake.posted.at(-1) as { rid: string };
    expect(send).toMatchObject({ t: "agent-session-send", src: "pi", sid: "pi-1", tx: "Inspect the repo", del: "next" });
    await act(async () => {
      fake.deliver({ t: "agent-command-receipt", rid: send.rid, src: "pi", sid: "pi-1", del: "immediate" });
    });

    act(() => {
      fake.deliver({ t: "agent-extension-ui-request", src: "pi", sid: "pi-1", rid: "ui-1", k: "confirm", ttl: "Proceed?", m: "Run it", er: true });
      for (let index = 0; index < 12; index += 1) {
        fake.deliver({
          t: "agent-extension-ui-request", src: "pi", sid: "pi-1", rid: `notice-${index}`,
          k: "status", key: "working", m: `Status ${index}`, er: false,
        });
      }
    });
    expect(screen.getByRole("dialog", { name: "Proceed?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(fake.posted.at(-1)).toEqual({ t: "agent-extension-ui-response", src: "pi", sid: "pi-1", rid: "ui-1", v: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await act(async () => {
      fake.deliver({ t: "agent-command-receipt", rid: "ui-1", src: "pi", sid: "pi-1", del: "ui" });
      fake.deliver({ t: "agent-extension-ui-dismissed", src: "pi", sid: "pi-1", rid: "ui-1" });
    });
    expect(screen.queryByRole("dialog", { name: "Proceed?" })).not.toBeInTheDocument();
    unmount();
  });

  it("renders the message composer as a roomy, padded field rather than a single cramped row", async () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);

    fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
    const create = fake.posted.at(-1) as { rid: string };
    await act(async () => {
      fake.deliver({
        t: "agent-command-receipt",
        rid: create.rid,
        src: "pi",
        sid: "pi-1",
        del: "created",
        s: {
          sid: "pi-1",
          src: "pi",
          ttl: "SDK-authored Pi session",
          lea: 123,
          ac: "ready",
          cap: { md: ["nice"], snd: true, str: true, abt: true, raw: false, pty: false, xui: true },
        },
      });
    });

    const field = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(field.className).toContain("min-h-12");
    expect(field.className).toContain("px-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    expect(field.className).toContain("focus:ring-2");
    // No inline height: jsdom measures every box at zero, and writing that would collapse the field
    // to nothing. A degenerate measurement has to leave the utilities in charge.
    expect(field.style.height).toBe("");
    unmount();
  });

  it("sizes a growing field to its content plus its border, not just its content", async () => {
    // `scrollHeight` is the padding box and the field is `border-box`, so a height taken straight
    // from it leaves the field exactly its own border short of the text it holds: an empty one
    // scrolls its placeholder and a draft's last line is clipped. Measured in the running panel
    // before this fix: an empty composer already had 2px of hidden content and could be scrolled.
    const metrics: Record<string, number> = { scrollHeight: 72, offsetHeight: 50, clientHeight: 48 };
    const originals = Object.keys(metrics).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
    ] as const);
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    }

    try {
      const { fake, unmount } = setup();
      deliverProjects(fake);
      deliverSessions(fake);

      fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
      const create = fake.posted.at(-1) as { rid: string };
      await act(async () => {
        fake.deliver({
          t: "agent-command-receipt",
          rid: create.rid,
          src: "pi",
          sid: "pi-1",
          del: "created",
          s: {
            sid: "pi-1",
            src: "pi",
            ttl: "SDK-authored Pi session",
            lea: 123,
            ac: "ready",
            cap: { md: ["nice"], snd: true, str: true, abt: true, raw: false, pty: false, xui: true },
          },
        });
      });

      const field = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: "a draft long enough to wrap onto a second line" } });

      // 72 of content plus the 2 the border takes (offsetHeight - clientHeight).
      expect(field.style.height).toBe("74px");
      unmount();
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  });
});

describe("visibility subscriptions recover from failure", () => {
  beforeEach(() => {
    localStorage.clear();
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
    const { fake, unmount } = setup();
    const first = latestSubscription(fake, "agent-projects-watch");
    act(() => {
      fake.deliver({
        t: "agent-projects-error",
        sub: first,
        r: "agent feed is not ready",
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("agent feed is not ready");
    // And it says so, so the error does not read as a dead end.
    expect(screen.getByRole("alert")).toHaveTextContent(/retrying/i);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const second = latestSubscription(fake, "agent-projects-watch");
    expect(second).not.toBe(first);

    // The retry succeeds, and the error gives way to real content.
    act(() => {
      fake.deliver({ t: "agent-projects", sub: second, p: FIXTURE_PROJECTS });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    unmount();
  });

  it("backs off between attempts rather than asking once a second forever", () => {
    const { fake, unmount } = setup();
    const attempts = [latestSubscription(fake, "agent-projects-watch")];
    const failCurrent = () => {
      act(() => {
        fake.deliver({
          t: "agent-projects-error",
          sub: attempts[attempts.length - 1]!,
          r: "agent feed is not ready",
        });
      });
    };

    failCurrent();
    act(() => void vi.advanceTimersByTime(1000));
    attempts.push(latestSubscription(fake, "agent-projects-watch"));

    // The second failure must wait longer than the first did.
    failCurrent();
    act(() => void vi.advanceTimersByTime(1000));
    expect(latestSubscription(fake, "agent-projects-watch")).toBe(attempts[1]);
    act(() => void vi.advanceTimersByTime(1000));
    attempts.push(latestSubscription(fake, "agent-projects-watch"));

    expect(new Set(attempts).size).toBe(3);
    unmount();
  });

  it("drops an expanded project's pending retry when the project collapses", () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    const sessionsSub = latestProjectSessionsSubscription(fake, FIXTURE_PROJECT_A.pp);
    act(() => {
      fake.deliver({
        t: "agent-project-sessions-error",
        sub: sessionsSub,
        pp: FIXTURE_PROJECT_A.pp,
        r: "agent feed is not ready",
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("agent feed is not ready");

    fireEvent.click(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ }));
    const beforeWait = fake.posted.length;
    act(() => void vi.advanceTimersByTime(30_000));
    const sessionWatchesAfter = fake.posted
      .slice(beforeWait)
      .filter((m) => (m as { t?: string }).t === "agent-project-sessions-watch");
    expect(sessionWatchesAfter).toHaveLength(0);
    unmount();
  });
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

  function windowInputSubscription(fake: FakeHostBridge): string {
    return latestSubscription(fake, "agent-window-input-watch");
  }

  /** Focuses the Claude field and returns its watch subscription: the watch is focus-gated now. */
  function focusComposer(fake: FakeHostBridge) {
    const field = screen.getByLabelText("Claude composer text");
    fireEvent.focus(field);
    return { field, sub: windowInputSubscription(fake) };
  }

  function deliverStatus(fake: FakeHostBridge, sub: string, overrides: Record<string, unknown> = {}) {
    act(() => {
      fake.deliver({
        t: "agent-window-input-status",
        sub,
        sid: "sid-claude-01",
        en: true,
        cur: true,
        tx: "",
        ...overrides,
      });
    });
  }

  it("is focusable before the first status, then disabled with the host's reason", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

    // Focusable before any status: the watch is focus-gated, so a field disabled "until a status
    // arrives" could never be focused and the status would never arrive.
    expect(screen.getByLabelText("Claude composer text")).toBeEnabled();

    const { sub } = focusComposer(fake);
    deliverStatus(fake, sub, { en: false, r: "terminal-only" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "running in a terminal",
    );
    // The only explicit action left is Enter, and it cannot fire without a window.
    expect(screen.getByRole("button", { name: "Send to Claude's composer" })).toBeDisabled();
    unmount();
  });

  it("names the two-instance case instead of leaving it as a bare unavailable", () => {
    // The host used to resolve this by picking the lowest-pid instance, which wrote into whichever
    // Claude launched first. Now it refuses and says so, and the viewer's fix -- close the session in
    // one of them -- has to be readable from the notice alone.
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { sub } = focusComposer(fake);

    deliverStatus(fake, sub, { en: false, r: "multiple-instances" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "more than one Claude instance",
    );
    unmount();
  });

  it("prefills from the window on focus and auto-syncs every edit after a debounce", async () => {
    vi.useFakeTimers();
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);

    deliverStatus(fake, sub, { tx: "half-written prompt" });

    expect(field).toBeEnabled();
    expect(field).toHaveValue("half-written prompt");

    fireEvent.change(field, { target: { value: "review the diff" } });
    // No fill button anymore, and Return still never sends: the sync is automatic.
    expect(screen.queryByRole("button", { name: "Fill Claude's composer" })).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(
      fake.posted.filter((m) => (m as { t?: string }).t === "agent-window-input-sync"),
    ).toHaveLength(0);

    // One burst of typing lands as one sync, 500ms after the last keystroke.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fake.posted.at(-1)).toMatchObject({
      t: "agent-window-input-sync",
      sid: "sid-claude-01",
      tx: "review the diff",
    });
    unmount();
  });

  it("clearing the field is an edit, so deletions sync as the empty value", async () => {
    vi.useFakeTimers();
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);
    deliverStatus(fake, sub, { tx: "text to delete" });

    fireEvent.change(field, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fake.posted.at(-1)).toMatchObject({
      t: "agent-window-input-sync",
      sid: "sid-claude-01",
      tx: "",
    });
    unmount();
  });

  it("blur flushes an unsynced edit and unwatches, stopping the host's poll", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);
    deliverStatus(fake, sub, { tx: "" });

    fireEvent.change(field, { target: { value: "about to leave" } });
    fireEvent.blur(field);

    // The flush push lands before the unwatch, so nothing typed is lost.
    expect(fake.posted.at(-2)).toMatchObject({
      t: "agent-window-input-sync",
      sid: "sid-claude-01",
      tx: "about to leave",
    });
    expect(fake.posted.at(-1)).toMatchObject({
      t: "agent-window-input-unwatch",
      sub,
    });
    unmount();
  });

  it("an echo of our own write marks the field in sync; an independent edit then lands", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);
    deliverStatus(fake, sub, { tx: "" });

    fireEvent.change(field, { target: { value: "mid" } });
    // The host's write echo arrives while the draft is still "unsent": matching text means field and
    // window agree again, so a LATER independent edit must be adopted rather than guarded forever.
    deliverStatus(fake, sub, { tx: "mid" });
    deliverStatus(fake, sub, { tx: "edited directly in Claude" });

    expect(field).toHaveValue("edited directly in Claude");
    unmount();
  });

  it("does not overwrite an in-flight edit with a status that arrives while typing", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);
    deliverStatus(fake, sub, { tx: "" });

    fireEvent.change(field, { target: { value: "mid-sentence" } });

    // The host re-resolves on a timer, so a status carrying the window's own text can land at any
    // moment. Adopting it here would delete what the viewer just typed.
    deliverStatus(fake, sub, { tx: "whatever the window holds" });

    expect(field).toHaveValue("mid-sentence");
    unmount();
  });

  it("the Enter button actually sends by filling and pressing Return", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);
    deliverStatus(fake, sub, { tx: "" });

    const sendButton = screen.getByRole("button", { name: "Send to Claude's composer" });
    expect(sendButton).toBeDisabled();

    fireEvent.change(field, { target: { value: "run the tests" } });
    expect(sendButton).toBeEnabled();

    fireEvent.click(sendButton);
    expect(fake.posted.at(-1)).toMatchObject({
      t: "agent-window-input-submit",
      sid: "sid-claude-01",
      tx: "run the tests",
    });
    unmount();
  });

  it("an off-Desktop window is prefilled by one automatic round trip", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { field, sub } = focusComposer(fake);

    deliverStatus(fake, sub, { cur: false });

    // No bring-window button: the round trip is the flow now, fired once on focus.
    expect(screen.queryByRole("button", { name: "Load from Claude window" })).toBeNull();
    const read = fake.posted.at(-1) as { t?: string; rid?: string };
    expect(read.t).toBe("agent-window-input-read");

    await act(async () => {
      fake.deliver({
        t: "agent-window-input-result",
        rid: read.rid,
        sid: "sid-claude-01",
        ok: true,
        tx: "found on the other Desktop",
      });
    });
    expect(field).toHaveValue("found on the other Desktop");
    unmount();
  });

  it("a failed round trip says a missing window mover is not something to retry", async () => {
    // macOS has no public API for moving another application's window between Desktops, so without
    // yabai an off-Desktop composer is unreachable, full stop. The automatic round trip fails once
    // and the caption names the real fix rather than inviting an endless retry.
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { sub } = focusComposer(fake);

    deliverStatus(fake, sub, { cur: false });
    const read = fake.posted.at(-1) as { rid: string };

    await act(async () => {
      fake.deliver({
        t: "agent-window-input-result",
        rid: read.rid,
        sid: "sid-claude-01",
        ok: false,
        r: "window-mover-unavailable",
      });
    });

    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent("needs yabai");
    unmount();
  });

  it("renders the shared band for Codex but keeps it unavailable", () => {
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);
    fireEvent.click(screen.getByText("Session Codex 01"));

    // The composer UI is shared across sources, so Codex still gets the band --
    // it is write-capable, but its window-fill mechanism is not built yet, so the
    // field is disabled and says why rather than offering a write that cannot
    // land.
    const field = screen.getByLabelText("Codex composer text");
    expect(field).toBeDisabled();
    expect(screen.getByLabelText("Codex composer")).toHaveTextContent(
      "Codex's window composer isn't available yet.",
    );
    // The Codex window mechanism is deferred, so no window watch is posted.
    expect(
      fake.posted.filter((m) => (m as { t?: string }).t === "agent-window-input-watch"),
    ).toHaveLength(0);
    unmount();
  });

  it("renders the composer as a roomy, padded field rather than a single cramped row", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    const { sub } = focusComposer(fake);

    deliverStatus(fake, sub, { tx: "" });

    const field = screen.getByLabelText("Claude composer text");
    // The resting height and padding are the load-bearing part of the redesign: a multi-line draft
    // must have room to breathe before it even begins to grow. `min-h-12` (a two-line resting field)
    // and the `px-4 py-3` gutter are the contract; the auto-grow cap stops the field from chasing a
    // wall of text forever.
    expect(field.className).toContain("min-h-12");
    expect(field.className).toContain("px-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    expect(field.className).toContain("focus:ring-2");
    unmount();
  });

  it("shows the context meter below the composer's action row, not in the header", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);

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
    const { fake, unmount } = setup();
    deliverProjects(fake);
    deliverSessions(fake);

    fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
    const create = fake.posted.at(-1) as { rid: string };
    await act(async () => {
      fake.deliver({
        t: "agent-command-receipt",
        rid: create.rid,
        src: "pi",
        sid: "pi-1",
        del: "created",
        s: {
          sid: "pi-1",
          src: "pi",
          ttl: "SDK-authored Pi session",
          lea: 123,
          ac: "ready",
          cap: { md: ["nice"], snd: true, str: true, abt: true, raw: false, pty: false, xui: true },
        },
      });
    });

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

describe("AskUserQuestion mirror", () => {
  // The same panel the live probe saw in Claude Desktop: question, header,
  // single-select options, Other, Skip, Submit, and the header controls.
  const QUESTION = {
    callId: "toolu_01RiU9jjyzyX3HTCbLG1dGAh",
    question: "Which release identity should the manual deploy of current main use?",
    header: "Release id",
    multiSelect: false,
    options: [
      {
        label: "Mint 2026-08-08.1 (Recommended)",
        description: "Add a ledger entry for a new application release.",
      },
      {
        label: "Reuse 2026-08-03.1",
        description: "Deploy immediately, no code change.",
      },
      {
        label: "Don't deploy app code yet",
        description: "Leave the running release alone.",
      },
    ],
  };

  const MULTI_QUESTION = {
    callId: "toolu_02",
    question: "Which features do you want to enable?",
    multiSelect: true,
    options: [
      { label: "Dark mode", description: "Enable dark theme for the interface" },
      { label: "Notifications", description: "Receive real-time alerts and updates" },
      { label: "Analytics", description: "Track usage and performance metrics" },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    feedMock.emitQuestion = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  function questionSubscription(fake: FakeHostBridge): string {
    return latestSubscription(fake, "agent-window-question-watch");
  }

  function deliverQuestionStatus(
    fake: FakeHostBridge,
    sub: string,
    overrides: Record<string, unknown> = {},
  ) {
    act(() => {
      fake.deliver({
        t: "agent-window-question-status",
        sub,
        sid: "sid-claude-01",
        en: true,
        cur: true,
        pr: true,
        sel: [],
        ...overrides,
      });
    });
  }

  function openQuestion(question: unknown) {
    act(() => feedMock.emitQuestion?.(question));
  }

  it("renders the panel from the feed JSON: question, options, Other, and every action", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "Which release identity should the manual deploy of current main use?",
    );
    // Single-select questions render radio rows.
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(
      screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Don't deploy app code yet" }),
    ).toBeInTheDocument();
    // The header controls and the action row mirror Claude's panel exactly.
    expect(screen.getByRole("button", { name: "View question options" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss question" })).toBeInTheDocument();
    expect(screen.getByLabelText("Other")).toBeInTheDocument();
    expect(screen.getByLabelText("Other answer")).toHaveAttribute(
      "placeholder",
      "Type your own answer here",
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();

    // The mirror watches the live panel state while the question is open.
    expect(questionSubscription(fake)).toBeTruthy();
    unmount();
  });

  it("posts a select action on choice and adopts the post-action read-back", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);

    fireEvent.click(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" }));
    const action = [...fake.posted]
      .reverse()
      .find((m) => (m as { t?: string }).t === "agent-window-question-action") as {
      rid: string;
      sid: string;
      k: string;
      oi: number;
      v: number;
    };
    expect(action).toMatchObject({ sid: "sid-claude-01", k: "select", oi: 1, v: 1 });

    await act(async () => {
      fake.deliver({
        t: "agent-window-question-result",
        rid: action.rid,
        sid: "sid-claude-01",
        ok: true,
        pr: true,
        sel: [1],
        oth: null,
        sb: true,
      });
    });
    expect(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    unmount();
  });

  it("renders multi-select as checkboxes and un-checks by pressing with the desired state", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(MULTI_QUESTION);

    expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(3);
    const dark = screen.getByRole("checkbox", { name: "Dark mode" });
    fireEvent.click(dark);
    let action = [...fake.posted]
      .reverse()
      .find((m) => (m as { t?: string }).t === "agent-window-question-action") as {
      rid: string;
      k: string;
      oi: number;
      v: number;
    };
    expect(action).toMatchObject({ k: "select", oi: 0, v: 1 });

    // The host reports it landed, pre-checked alongside a host-side selection.
    await act(async () => {
      fake.deliver({
        t: "agent-window-question-result",
        rid: action.rid,
        sid: "sid-claude-01",
        ok: true,
        pr: true,
        sel: [0, 1],
        oth: null,
        sb: true,
      });
    });
    expect(dark).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).toBeChecked();

    // Un-checking a box asks the host to press it toward unchecked.
    fireEvent.click(dark);
    action = [...fake.posted]
      .reverse()
      .find((m) => (m as { t?: string }).t === "agent-window-question-action") as {
      k: string;
      oi: number;
      v: number;
    };
    expect(action).toMatchObject({ k: "select", oi: 0, v: 0 });
    unmount();
  });

  it("debounces Other typing into an other action, and other-empty is a real intent", async () => {
    vi.useFakeTimers();
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);

    const other = screen.getByLabelText("Other answer");
    fireEvent.change(other, { target: { value: "Deploy a different release" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fake.posted.at(-1)).toMatchObject({
      t: "agent-window-question-action",
      sid: "sid-claude-01",
      k: "other",
      tx: "Deploy a different release",
    });

    // Clearing the input pushes the empty value, matching the composer's deletion rule.
    fireEvent.change(other, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fake.posted.at(-1)).toMatchObject({ t: "agent-window-question-action", k: "other", tx: "" });
    unmount();
  });

  it("posts submit, skip, and dismiss with no payload", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);
    const sub = questionSubscription(fake);
    deliverQuestionStatus(fake, sub, { sel: [0], sb: true });

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(
      [...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action"),
    ).toMatchObject({ k: "submit" });
    // Each explicit action holds the controls until its result lands; resolve
    // between clicks so the next control is enabled again.
    await act(async () => {
      fake.deliver({
        t: "agent-window-question-result",
        rid: ([...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action") as { rid: string }).rid,
        sid: "sid-claude-01",
        ok: true,
        pr: true,
        sel: [0],
        oth: null,
        sb: true,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(
      [...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action"),
    ).toMatchObject({ k: "skip" });
    // Skip keeps the panel up in the window until Claude records it; only Dismiss
    // ends the test, so the mirror stays mounted.
    await act(async () => {
      fake.deliver({
        t: "agent-window-question-result",
        rid: ([...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action") as { rid: string }).rid,
        sid: "sid-claude-01",
        ok: true,
        pr: true,
        sel: [0],
        oth: null,
        sb: true,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(
      [...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action"),
    ).toMatchObject({ k: "dismiss" });
    unmount();
  });

  it("adopts pre-checked selection from the window's live state", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(MULTI_QUESTION);
    const sub = questionSubscription(fake);

    deliverQuestionStatus(fake, sub, { sel: [0, 2], sb: true });

    expect(screen.getByRole("checkbox", { name: "Dark mode" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Analytics" })).toBeChecked();
    unmount();
  });

  it("hides the mirror when the host reports the panel is gone, and closes the watch", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);
    const sub = questionSubscription(fake);

    deliverQuestionStatus(fake, sub, { pr: false });

    expect(screen.queryByLabelText("Claude question")).toBeNull();
    unmount();
  });

  it("unwatches when the question closes in the feed", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);
    expect(questionSubscription(fake)).toBeTruthy();

    openQuestion(null);
    expect(fake.posted.at(-1)).toMatchObject({ t: "agent-window-question-unwatch" });
    unmount();
  });

  it("surfaces the host's reason when the window is unreachable", () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);
    const sub = questionSubscription(fake);

    deliverQuestionStatus(fake, sub, { en: false, r: "terminal-only", pr: null });

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "running in a terminal",
    );
    expect(screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" })).toBeDisabled();
    unmount();
  });

  it("shows the option description when View options is toggled", async () => {
    const { fake, unmount } = setup();
    openClaudeThread(fake);
    openQuestion(QUESTION);

    expect(screen.queryByText("Add a ledger entry for a new application release.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View question options" }));
    expect(
      [...fake.posted].reverse().find((m) => (m as { t?: string }).t === "agent-window-question-action"),
    ).toMatchObject({ k: "view-options" });
    expect(screen.getByText("Add a ledger entry for a new application release.")).toBeInTheDocument();
    unmount();
  });
});
