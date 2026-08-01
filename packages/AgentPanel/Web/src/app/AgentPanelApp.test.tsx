/**
 * Render tests for the webview App shell.
 *
 * These tests use a FakeHostBridge to drive the BridgeDataSource and assert
 * navigation behavior: project list renders, selecting a project shows sessions,
 * selecting a session mounts the thread view, and back navigation returns to the
 * prior level.
 *
 * ActivityFeed is mocked (it's a heavy virtualized component that depends on
 * ProseMirror/Milkdown) -- we assert that it is mounted and that the bridge
 * received an agent-thread-sub message, which is the behavioral signal that the
 * data layer wired up correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BridgeDataSource } from "../features/activity-feed/data-source/BridgeDataSource";
import { FakeHostBridge } from "../features/activity-feed/data-source/HostBridge";
import { App } from "./AgentPanelApp";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock ActivityFeed so Milkdown/ProseMirror never loads in jsdom.
vi.mock("../features/activity-feed/ActivityFeed", () => ({
  ActivityFeed: ({
    source,
    sessionId,
    controlsHost,
  }: {
    source: string;
    sessionId: string;
    controlsHost: HTMLElement | null;
  }) => (
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
  ),
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
  const sub = latestSubscription(fake, "agent-project-sessions-watch");
  act(() => {
    fake.deliver({
      t: "agent-project-sessions",
      sub,
      pp: FIXTURE_PROJECT_A.pp,
      ss: FIXTURE_SESSIONS,
    });
  });
}

function openClaudeThread(fake: FakeHostBridge) {
  deliverProjects(fake);
  fireEvent.click(screen.getByText("Alpha Project"));
  deliverSessions(fake);
  fireEvent.click(screen.getByText("Session Claude 01"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the project list title on mount", () => {
    const { unmount } = setup();
    expect(screen.getByText("Agent Feed")).toBeInTheDocument();
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

  it("navigates to session list when a project is selected", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    // Tap Alpha Project
    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);

    // Header should show the project name
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha Project");

    // Session list should show both sessions
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Session Codex 01")).toBeInTheDocument();

    // Project list items no longer visible
    expect(screen.queryByText("Beta Project")).not.toBeInTheDocument();

    unmount();
  });

  it("shows live dot for a live session in the session list", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);

    // session-claude-01 is live; the live dot has aria-label="Live"
    const liveDots = screen.getAllByLabelText("Live");
    expect(liveDots.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  it("mounts the thread view when a session is selected", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);
    fireEvent.click(screen.getByText("Session Claude 01"));

    // ActivityFeed mock should be in the DOM with the correct sessionId.
    const feed = screen.getByTestId("activity-feed");
    expect(feed).toBeInTheDocument();
    expect(feed).toHaveAttribute("data-session-id", "sid-claude-01");

    // The header title should reflect the session.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Session Claude 01");

    // Session list items are no longer visible.
    expect(screen.queryByText("Session Codex 01")).not.toBeInTheDocument();

    expect(feed).toHaveAttribute("data-source", "claude");
    expect(fake.posted).toContainEqual(
      expect.objectContaining({ t: "agent-projects-watch" }),
    );

    unmount();
  });

  it("back from thread view returns to session list", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);
    fireEvent.click(screen.getByText("Session Claude 01"));

    // Confirm we're in thread view
    expect(screen.getByTestId("activity-feed")).toBeInTheDocument();

    // Press back
    fireEvent.click(screen.getByLabelText("Go back"));
    deliverSessions(fake);

    // Should be back on the session list for Alpha Project
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();

    unmount();
  });

  it("back from session list returns to project list", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);

    // Confirm we're in session list
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();

    // Press back
    fireEvent.click(screen.getByLabelText("Go back"));
    deliverProjects(fake);

    // Should be back on the project list
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByText("Beta Project")).toBeInTheDocument();

    unmount();
  });

  it("project list header is visible again after navigating back from sessions", () => {
    const { fake, unmount } = setup();

    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);
    fireEvent.click(screen.getByLabelText("Go back"));
    deliverProjects(fake);

    expect(screen.getByText("Agent Feed")).toBeInTheDocument();
    unmount();
  });

  it("owns exactly one visibility watch and ignores a late parent snapshot", () => {
    const { fake, unmount } = setup();
    const projectsSub = latestSubscription(fake, "agent-projects-watch");
    deliverProjects(fake);

    fireEvent.click(screen.getByText("Alpha Project"));
    const sessionsSub = latestSubscription(
      fake,
      "agent-project-sessions-watch",
    );

    expect(fake.posted).toContainEqual({
      t: "agent-projects-unwatch",
      sub: projectsSub,
    });
    expect(fake.posted).toContainEqual({
      t: "agent-project-sessions-watch",
      sub: sessionsSub,
      pp: "/projects/alpha",
    });

    act(() => {
      fake.deliver({
        t: "agent-projects",
        sub: projectsSub,
        p: [
          {
            pp: "/projects/stale",
            dn: "Stale Project",
            sc: { cl: 1, co: 0 },
            sn: 1,
            lea: Date.now(),
          },
        ],
      });
    });
    expect(screen.queryByText("Stale Project")).not.toBeInTheDocument();

    deliverSessions(fake);
    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(fake.posted).toContainEqual({
      t: "agent-project-sessions-unwatch",
      sub: sessionsSub,
    });
    unmount();
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
    fireEvent.click(screen.getByText("Alpha Project"));
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

  it("keeps closing fenced from delayed ready and does not close twice on back", () => {
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

    fireEvent.click(screen.getByLabelText("Go back"));
    expect(
      fake.posted.filter(
        (message) => (message as { t?: string }).t === "agent-terminal-close",
      ),
    ).toHaveLength(1);
    unmount();
  });

  it("posts close then context-ended before back changes navigation", () => {
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

    fireEvent.click(screen.getByLabelText("Go back"));

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
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByLabelText("Go back"));
    deliverSessions(fake);
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
    fireEvent.click(screen.getByLabelText("Go back"));
    deliverSessions(fake);
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
    fireEvent.click(screen.getByText("Alpha Project"));
    deliverSessions(fake);

    fireEvent.click(screen.getByRole("button", { name: "New Pi session" }));
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
    });
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
});

describe("visibility subscriptions recover from failure", () => {
  beforeEach(() => {
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

  it("a pending retry is dropped when the viewer navigates away", () => {
    // Otherwise a timer armed on the project list fires against a screen the
    // viewer already left, re-subscribing to a layer nothing is showing.
    const { fake, unmount } = setup();
    deliverProjects(fake);
    fireEvent.click(screen.getByText("Alpha Project"));
    const sessionsSub = latestSubscription(fake, "agent-project-sessions-watch");
    act(() => {
      fake.deliver({
        t: "agent-project-sessions-error",
        sub: sessionsSub,
        pp: FIXTURE_PROJECT_A.pp,
        r: "agent feed is not ready",
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("agent feed is not ready");

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    const beforeWait = fake.posted.length;
    act(() => void vi.advanceTimersByTime(30_000));
    const sessionWatchesAfter = fake.posted
      .slice(beforeWait)
      .filter((m) => (m as { t?: string }).t === "agent-project-sessions-watch");
    expect(sessionWatchesAfter).toHaveLength(0);
    unmount();
  });
});
