/**
 * Render tests for the webview App shell.
 *
 * The App has two collaborators and these tests drive both: a FakeHttpTransport standing in for
 * the sidecar behind `feed`, and a FakeHostBridge standing in for the Mac's native authority
 * behind `host`. Keeping them apart in the test is the point -- a shell behaviour that reached
 * the wrong one would pass against a single merged fake.
 *
 * ActivityFeed is mocked (it's a heavy virtualized component that depends on
 * ProseMirror/Milkdown), so the signal that the data layer wired up correctly is that the feed
 * mounted against the selected thread.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_CARD_WIDTH,
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
} from "../features/bots/botCanvasPreferences";
import { render, screen, fireEvent, act, cleanup, waitFor, within } from "@testing-library/react";
import { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "../features/activity-feed/data-source/HostActionsClient";
import { FakeHostBridge } from "../features/activity-feed/data-source/HostBridge";
import { FakeHttpTransport } from "../features/activity-feed/transport/FakeHttpTransport";
import { storeSidebarPreferences } from "../features/sidebar/sidebarPreferences";
import { App } from "./AgentPanelApp";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock ActivityFeed so Milkdown/ProseMirror never loads in jsdom.
vi.mock("../features/activity-feed/ActivityFeed", async () => {
  const { useEffect } = await import("react");
  const { useDataSource } = await import("../features/activity-feed/data-source/AgentDataSourceContext");
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
      // The real feed opens the thread's stream, and extension-UI prompts ride it. A mock that
      // rendered without opening it would leave the App listening to a stream nobody asked for.
      const dataSource = useDataSource();
      useEffect(
        () => dataSource.subscribeSessionEvents(
          { source, sessionId, mode: "nice" },
          0,
          { onEvent: () => {}, onSnapshot: () => {} },
        ),
        [dataSource, sessionId, source],
      );
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

const terminalPaneMock = vi.hoisted(() => ({
  composerContext: null as Record<string, unknown> | null,
  // Whether the pane was handed something to be a share of, rather than left to ask the viewport.
  // Recorded because a session rendered inside a Bot card must never ask the viewport: a share of
  // the screen is more than the whole card.
  composerHasBasis: null as boolean | null,
  context: null as Record<string, unknown> | null,
  onState: null as ((context: Record<string, unknown>, state: Record<string, unknown>) => void) | null,
}));

// App-shell tests exercise ownership and placement. The renderer itself has a focused test with a
// fake xterm, so jsdom does not need a canvas merely because one shell test opens the pane.
vi.mock("../features/terminal/AgentTerminalPane", () => ({
  AgentTerminalPane: ({ context, onState, heightBasis }: {
    context: Record<string, unknown>;
    onState: (context: Record<string, unknown>, state: Record<string, unknown>) => void;
    heightBasis?: HTMLElement | null;
  }) => {
    // Two panes can be mounted at once -- the thread's own terminal in the composer and a resumed
    // CLI on the Terminals surface -- so they are recorded apart. A single slot took whichever
    // rendered last, which is a render-order dependency rather than a fact about the shell.
    if (context.kind === "session-tmux") {
      terminalPaneMock.composerContext = context;
      terminalPaneMock.composerHasBasis = heightBasis instanceof HTMLElement;
    } else {
      terminalPaneMock.context = context;
      terminalPaneMock.onState = onState;
    }
    const provider = context.source === "claude" ? "Claude" : "Codex";
    return (
      <section
        aria-label={`${provider}${context.kind === "session-tmux" ? " session" : ""} terminal`}
      />
    );
  },
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

// The sidecar's own shapes, unabbreviated. There is no rename layer between here and the panel
// any more, so a fixture that drifts from the sidecar fails rather than being translated.
const FIXTURE_PROJECT_A = {
  projectPath: "/projects/alpha",
  displayName: "Alpha Project",
  sourceCounts: { claude: 1, codex: 1 },
  sessionCount: 2,
  lastEventAt: Date.now() - 10_000,
};

const FIXTURE_PROJECT_B = {
  projectPath: "/projects/beta",
  displayName: "Beta Project",
  sourceCounts: { claude: 1, codex: 0 },
  sessionCount: 1,
  lastEventAt: Date.now() - 5_000,
};

const FIXTURE_PROJECTS = [FIXTURE_PROJECT_A, FIXTURE_PROJECT_B];
const READ_ONLY_CAPABILITIES = {
  modes: ["raw", "nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: true,
  canOpenTerminal: true,
  supportsExtensionUi: false,
  canStreamLive: false,
};
const FIXTURE_SESSIONS = [
  {
    sessionId: "sid-claude-01",
    source: "claude" as const,
    title: "Session Claude 01",
    lastEventAt: Date.now() - 10_000,
    activity: "live" as const,
    capabilities: READ_ONLY_CAPABILITIES,
  },
  {
    sessionId: "sid-codex-01",
    source: "codex" as const,
    title: "Session Codex 01",
    lastEventAt: Date.now() - 60_000,
    activity: "ready" as const,
    capabilities: READ_ONLY_CAPABILITIES,
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

/** `terminalIds` hands out request ids in order, for the tests that need to tell two apart. */
function setup(terminalIds: string[] = []) {
  const fake = new FakeHostBridge();
  const transport = new FakeHttpTransport();
  const pending = [...terminalIds];
  let sequence = 0;
  const host = new HostActionsClient(fake, {
    requestIDFactory: (prefix) =>
      prefix === "terminal"
        ? pending.shift() ?? "request-1"
        : `${prefix}-${++sequence}`,
  });
  const { unmount } = render(<App feed={new SidecarDataSource(transport)} host={host} />);
  act(() => {
    transport.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });
  });
  return { fake, transport, host, unmount };
}

/** The newest subscription id the App posted for a native-authority watch. */
/** Claude's composer and question stream. One path, because the sidecar sends both down it. */
const COMPOSER_STREAM = "/api/window/composer/stream";

function latestSubscription(fake: FakeHostBridge, type: string): string {
  const message = [...fake.posted]
    .reverse()
    .find((candidate) => (candidate as { t?: string }).t === type) as
    | { sub?: string }
    | undefined;
  if (!message?.sub) throw new Error(`missing ${type}`);
  return message.sub;
}

function deliverProjects(transport: FakeHttpTransport) {
  act(() => {
    transport.deliver("/api/inventory/stream", { projects: FIXTURE_PROJECTS });
  });
}

function deliverSessions(transport: FakeHttpTransport) {
  deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, FIXTURE_SESSIONS);
}

function deliverProjectSessions(
  transport: FakeHttpTransport,
  projectPath: string,
  sessions: typeof FIXTURE_SESSIONS | Array<Record<string, unknown>>,
) {
  act(() => {
    transport.deliver(`projectPath=${encodeURIComponent(projectPath)}`, { projectPath, sessions });
  });
}

const PI_SESSION = {
  sessionId: "pi-1",
  source: "pi",
  projectPath: FIXTURE_PROJECT_A.projectPath,
  title: "SDK-authored Pi session",
  lastEventAt: 123,
  activity: "ready",
  capabilities: {
    modes: ["nice"],
    canSend: true,
    canSteer: true,
    canAbort: true,
    canFetchRaw: false,
    canOpenTerminal: false,
    supportsExtensionUi: true,
    canStreamLive: true,
  },
};

/** Clicks New Pi session and lets the sidecar answer with the descriptor the panel then opens. */
async function createPiSession(transport: FakeHttpTransport) {
  transport.responses.set("POST /api/agent-sessions", {
    status: 201,
    body: JSON.stringify(PI_SESSION),
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
  });
}

function openClaudeThread(transport: FakeHttpTransport) {
  deliverProjects(transport);
  deliverSessions(transport);
  fireEvent.click(screen.getByText("Session Claude 01"));
}

function emitTerminalState(state: Record<string, unknown>) {
  const context = terminalPaneMock.context;
  const onState = terminalPaneMock.onState;
  if (!context || !onState) throw new Error("terminal pane is not mounted");
  act(() => onState(context, state));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  it("opens on the Sessions view", () => {
    const { unmount } = setup();
    expect(screen.getByText("Agent Feed")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "false");
    unmount();
  });

  it("comes back to the view that was chosen, not to Sessions", () => {
    // The canvas is somewhere a reader stays: they arrange it, then reload the page many times
    // while working on what it shows. Landing back on Sessions each time means re-choosing the
    // arrangement before the reload has told them anything.
    const first = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    first.unmount();

    const restored = setup();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "false");
    restored.unmount();
  });

  it("names the chosen view in the address, and lets the address win on the way back", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(window.location.search).toBe("?view=canvas");
    first.unmount();

    // The address is what a reload actually carries, so a stored preference must not override it.
    window.history.replaceState(null, "", "/?view=bots");
    const restored = setup();
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "false");
    restored.unmount();
  });

  it("gives the titlebar inset to the header at the window's leading edge", () => {
    const { unmount } = setup();
    const navigationHeader = screen.getByRole("tablist", { name: "Agent views" }).parentElement;
    const threadHeader = screen.getByRole("banner");

    expect(navigationHeader).toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(threadHeader).not.toHaveClass("agent-window-titlebar-main-leading");

    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(screen.queryByRole("tablist", { name: "Agent views" })).not.toBeInTheDocument();
    expect(threadHeader).toHaveClass("agent-window-titlebar-main-leading");
    expect(
      screen.getByRole("button", { name: "Pin agent sidebar" })
        .querySelector(".lucide-panel-left"),
    ).not.toBeNull();
    unmount();
  });

  it("clears the session workspace in the empty Bots view and restores it on return", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No bots yet")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Project")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Claude composer text")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bots");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Bots" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.queryByText("No bots yet")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Session Claude 01");
    unmount();
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

  it("shows every Bot at once on the canvas, and opens one session inline at a time", () => {
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
    // nothing selected and no Bot picked.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
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
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    expect(screen.getByRole("region", { name: /^Session Codex 01 session/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Codex composer text")).toBeInTheDocument();
    // The open row is the session's titlebar, so the feed's controls have somewhere to portal
    // after all -- the card's own row rather than the app's header.
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-controls-host", "attached");

    // One at a time: opening another Bot's session closes the first, so the roster never holds
    // more than one open stream.
    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.getAllByTestId("activity-feed")).toHaveLength(1);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");

    fireEvent.click(canvas().getByRole("button", { name: /^Session Claude 01/ }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();
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

    // Swapping the row's field for its terminal hands that pane the session's column to be a share
    // of. Left to ask the viewport it would open taller than the card holding it.
    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));
    expect(terminalPaneMock.composerContext).toEqual({
      kind: "session-tmux",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    expect(terminalPaneMock.composerHasBasis).toBe(true);
    expect(screen.queryByLabelText("Claude composer text")).not.toBeInTheDocument();
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

  it("opens a session picked in the canvas roster on the canvas, and scrolls its card to it", () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
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

      const roster = within(screen.getByRole("list", { name: "Bots" }));
      scrollIntoView.mockClear();
      scrolled.length = 0;
      fireEvent.click(roster.getByRole("button", { name: /^Session Claude 01/ }));

      // On the canvas, not instead of it: the roster is still up and the card unfolded in place.
      expect(screen.getByRole("list", { name: "Bot canvas" })).toBeInTheDocument();
      expect(canvas().getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-claude-01");

      // And the card came to the reader, because in a tiled roster it can be anywhere.
      const card = canvas().getByRole("button", { name: /^Session Claude 01/ }).closest("li")!.closest("ul")!.closest("li");
      expect(scrolled).toContain(card);

      // The roster marks the row that is open, which is what "selected" means on this tab.
      expect(roster.getByRole("button", { name: /^Session Claude 01/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
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
        bots: [{
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
        }],
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
    expect(sessions().style.width).toBe("260px");

    // Opened, the width it was stored at -- which the panel does not get a say in either, and which
    // now has a grip, because there is a width to drag.
    fireEvent.click(within(card!).getByRole("button", { name: /^Session Claude 01/ }));
    expect(sessions().style.width).toBe("900px");
    expect(
      screen.getByRole("separator", { name: /^Resize Session Claude 01.* session$/ }),
    ).toBeInTheDocument();
    unmount();
  });

  it("reorders the strip from a card's menu, and stands the Bots that way again after a reload", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    const deliver = () => act(() => {
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
        }, {
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
        }],
      });
    });
    deliver();

    // Read off each card's own session list, which is labelled with its Bot. The name in the header
    // is not a usable handle: the avatar beside it carries the Bot's initials in the same span.
    const standing = () =>
      [...document.querySelectorAll('ul[aria-label="Bot canvas"] > li')].map((card) =>
        card.querySelector('ul[aria-label$=" sessions"]')?.getAttribute("aria-label") ?? "",
      );
    expect(standing()).toEqual(["Release Captain sessions", "Nightly Sweeper sessions"]);

    // The left end offers no way further left, so the entry is absent rather than dead.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Release Captain" }));
    expect(screen.queryByRole("menuitem", { name: "Move left" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));

    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    expect(JSON.parse(localStorage.getItem("agent-panel.bot-canvas.order") ?? "[]")).toEqual([
      "bot-2",
      "bot-1",
    ]);

    // The roster arriving again does not undo the arrangement: order is remembered, not derived
    // from whatever sequence the sidecar happened to resolve.
    deliver();
    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    unmount();

    const second = setup();
    deliverProjects(second.transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      second.transport.deliver("/api/bots/stream", {
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
        }, {
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
        }],
      });
    });
    expect(standing()).toEqual(["Nightly Sweeper sessions", "Release Captain sessions"]);
    second.unmount();
  });

  it("forks a session from its canvas row menu into a terminal of its own", async () => {
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

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));

    // The name first, and nothing started yet. `-n` sets the session's address as well as its
    // title, so this is the only moment it is free -- afterwards the fork has already been listed
    // under whatever it was called.
    const field = screen.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toBe("Session Claude 01 (fork 1)");
    expect(terminalPaneMock.context).toBeNull();

    fireEvent.change(field, { target: { value: "Retry the flaky gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    // Its own name from the first paint, with no round trip through the pane: the shell chose it.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Retry the flaky gate");
    // A fork has no transcript to show: the CLI writes none until its first turn, so the view says
    // that rather than spinning on a file that is not coming, and it names where it came from.
    expect(screen.getByText(/appears here once you send the first message/)).toBeInTheDocument();
    expect(screen.getByText(/Forked from/)).toBeInTheDocument();
    expect(screen.queryByTestId("activity-feed")).toBeNull();

    // The terminal is the whole session until then, and it points at the fork rather than at the
    // session it branched from -- carrying the name, which is an argument of its command.
    expect(terminalPaneMock.context).toEqual({
      kind: "session-fork",
      source: "claude",
      sessionId: "sid-claude-01",
      forkId: expect.any(String),
      title: "Retry the flaky gate",
    });

    fireEvent.click(screen.getByRole("button", { name: "Close fork" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
    unmount();
  });

  it("gives a fork back to its Bot once its first turn writes a transcript", async () => {
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

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    const forkId = terminalPaneMock.context!.forkId as string;

    // Nothing yet: a fork writes no transcript until its first turn, and the sidecar refuses a
    // session that is not in the catalog rather than recording a reference to a maybe.
    expect(transport.requests.some((request) => request.path === "/api/bots/bot-1/sessions"))
      .toBe(false);

    // The first turn. The session appears under the id the fork was STARTED with, which is the
    // only reason the shell can recognize it.
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, [
      ...FIXTURE_SESSIONS,
      {
        sessionId: forkId,
        source: "claude",
        title: "Session Claude 01 (fork 1)",
        lastEventAt: 9,
        activity: "live",
        capabilities: FIXTURE_SESSIONS[0]!.capabilities,
      },
    ]);

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions")?.body)
      .toEqual({
        sessionRefs: [{ source: "claude", sessionId: forkId }],
        requestId: expect.any(String),
      });

    // Once, not once per inventory push: the Bot snapshot that would make it a no-op arrives a
    // moment after the attach, and every push in between re-runs the effect.
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, [
      ...FIXTURE_SESSIONS,
      {
        sessionId: forkId,
        source: "claude",
        title: "Session Claude 01 (fork 1)",
        lastEventAt: 10,
        activity: "live",
        capabilities: FIXTURE_SESSIONS[0]!.capabilities,
      },
    ]);
    expect(
      transport.requests.filter((request) => request.path === "/api/bots/bot-1/sessions"),
    ).toHaveLength(1);
    unmount();
  });

  it("starts nothing when the fork dialog is cancelled", async () => {
    // The dialog is the whole commitment point. Backing out of it must leave no pane, no tmux
    // session and no `claude --fork-session`, because a fork that exists is already listed under
    // its name to every other agent and cannot be taken back.
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

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(terminalPaneMock.context).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
    unmount();
  });

  it("renames a session from its canvas row menu", async () => {
    const { transport, unmount } = setup();
    transport.responses.set("POST /api/sessions/claude/sid-claude-01/title", {
      status: 200,
      body: JSON.stringify({ sessionId: "sid-claude-01", title: "What I called it" }),
    });
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

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));

    // Seeded with the name that is there, because a rename is usually an edit of it.
    const field = screen.getByLabelText(/Title/) as HTMLInputElement;
    expect(field.value).toBe("Session Claude 01");

    fireEvent.change(field, { target: { value: "  What I called it  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/sessions/claude/sid-claude-01/title",
      body: { title: "What I called it" },
    });
    // Closed on success. The new title arrives through the inventory stream like every other
    // change to a session, so there is nothing for the dialog to hold on to.
    expect(screen.queryByRole("heading", { name: "Rename session" })).toBeNull();
    unmount();
  });

  it("keeps the rename dialog open and says why when the sidecar refuses", async () => {
    const { transport, unmount } = setup();
    transport.responses.set("POST /api/sessions/claude/sid-claude-01/title", {
      status: 400,
      body: JSON.stringify({
        error: { code: "invalid-title", message: "a session title cannot contain a line break" },
      }),
    });
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

    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });

    // The sidecar's own reason, not "sidecar answered 400": the reader has to be able to fix it.
    expect(screen.getByRole("alert")).toHaveTextContent("cannot contain a line break");
    expect(screen.getByRole("heading", { name: "Rename session" })).toBeInTheDocument();
    unmount();
  });

  it("detaches a session from a Bot through its canvas row menu", async () => {
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
          missingSessionRefs: [{ source: "codex", sessionId: "sid-forgotten" }],
        }],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    // The menu is a sibling of the row's disclosure, not inside it, so opening the menu must not
    // also open the transcript.
    fireEvent.click(canvas().getByRole("button", { name: "Actions for Session Claude 01" }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));
    });

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions/detach")).toEqual({
      method: "POST",
      path: "/api/bots/bot-1/sessions/detach",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
      },
    });

    // The row a Bot can otherwise never be rid of: no summary, so no title, and it still has to
    // carry the same action.
    fireEvent.click(canvas().getByRole("button", { name: "Actions for sid-forgotten" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));
    });
    expect(
      transport.requests.filter((request) => request.path === "/api/bots/bot-1/sessions/detach").at(-1)?.body,
    ).toEqual({
      requestId: expect.any(String),
      sessionRefs: [{ source: "codex", sessionId: "sid-forgotten" }],
    });
    unmount();
  });

  it("attaches a session to a Bot from its canvas card", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-beta",
          name: "Beta Curator",
          environment: { kind: "directory", path: FIXTURE_PROJECT_B.projectPath },
          sessionRefs: [],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [],
          missingSessionRefs: [],
        }],
      });
    });

    // The picker reads the Bot's directory off the inventory stream, so opening it from the canvas
    // has to widen that subscription exactly as opening it from the sidebar does.
    fireEvent.click(canvas().getByRole("button", { name: "Add sessions to Beta Curator" }));
    await waitFor(() => {
      expect(transport.subscriptions.map((subscription) => subscription.path)).toContainEqual(
        expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`),
      );
    });
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [FIXTURE_SESSIONS[0]!]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Session Claude 01/ }));

    transport.responses.set("POST /api/bots/bot-beta/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-beta" }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add sessions" }));
    });

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-beta/sessions")).toEqual({
      method: "POST",
      path: "/api/bots/bot-beta/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
      },
    });
    // Attaching leaves the canvas up rather than dropping the reader into the thread.
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });

  it("cannot attach to a Bot whose directory is gone", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-gone",
          name: "Orphan",
          environment: { kind: "directory", path: "/projects/deleted" },
          sessionRefs: [],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "missing",
          sessions: [],
          missingSessionRefs: [],
        }],
      });
    });

    expect(canvas().getByRole("button", { name: "Add sessions to Orphan" })).toBeDisabled();
    unmount();
  });

  it("walks all three views with the arrow keys, wrapping at the ends", () => {
    const { unmount } = setup();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Sessions" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Bots" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Bots" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");

    // Wrapping, not clamping: the last view is one keystroke from the first.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Canvas" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Sessions" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Canvas" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    unmount();
  });

  it("removes an attached session from a Bot through the row's actions menu", async () => {
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
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { role: "Coordinates releases", labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
        }],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    // The menu is a sibling of the row's own button, not inside it, so opening it must not also
    // open the session.
    fireEvent.click(screen.getByRole("button", { name: /Actions for Session Claude 01/ }));
    expect(screen.queryByTestId("activity-feed")).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));

    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions/detach"))
        .toEqual({
          // A POST, because the host relay admits GET and POST only.
          method: "POST",
          path: "/api/bots/bot-1/sessions/detach",
          body: {
            requestId: expect.any(String),
            sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          },
        });
    });
    // Nothing is removed locally: the row leaves when the Bot stream publishes without it, which
    // is also what happens when the same Bot is edited from another surface.
    expect(screen.getByRole("button", { name: /^Session Claude 01/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove from bot" })).not.toBeInTheDocument();
    unmount();
  });

  it("removes a reference whose transcript the catalog has forgotten", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
          metadata: { role: "", labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [],
          // This row has no summary and cannot be opened, so the menu is the only thing that can
          // act on it -- and without one it would be the single entry a Bot can never be rid of.
          missingSessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
        }],
      });
    });
    transport.responses.set("POST /api/bots/bot-1/sessions/detach", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for sid-gone" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from bot" }));

    await waitFor(() => {
      expect(transport.requests.find((request) => request.path === "/api/bots/bot-1/sessions/detach")?.body)
        .toEqual({
          requestId: expect.any(String),
          sessionRefs: [{ source: "codex", sessionId: "sid-gone" }],
        });
    });
    unmount();
  });

  it("creates a Bot from a name, icon, and existing project directory", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));
    fireEvent.click(screen.getByRole("radio", { name: /Alpha Project/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Release Captain" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Icon URL/ }), { target: { value: "https://example.com/captain.png" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Role/ }), { target: { value: "Coordinates releases" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Labels/ }), { target: { value: "release, platform" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Metadata/ }), { target: { value: "team=platform" } });

    transport.responses.set("POST /api/bots", {
      status: 201,
      body: JSON.stringify({
        botId: "bot-created",
        name: "Release Captain",
        iconUrl: "https://example.com/captain.png",
        environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
        sessionRefs: [],
        metadata: {
          role: "Coordinates releases",
          labels: ["release", "platform"],
          custom: { team: "platform" },
        },
        grants: [],
        createdAt: 1,
        createdBy: { kind: "user" },
        environmentAvailability: "available",
        sessions: [],
        missingSessionRefs: [],
      }),
    });

    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Add Bot" })).getByRole("button", { name: "Add Bot" }));
    });

    expect(transport.requests.find((request) => request.method === "POST" && request.path === "/api/bots")).toEqual({
      method: "POST",
      path: "/api/bots",
      body: expect.objectContaining({
        requestId: expect.any(String),
        name: "Release Captain",
        iconUrl: "https://example.com/captain.png",
        directoryPath: FIXTURE_PROJECT_A.projectPath,
        metadata: {
          role: "Coordinates releases",
          labels: ["release", "platform"],
          custom: { team: "platform" },
        },
        grants: [],
      }),
    });
    expect(screen.queryByRole("dialog", { name: "Add Bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bots");
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    unmount();
  });

  it("attaches sessions from a Bot row using only that Bot directory", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    act(() => {
      transport.deliver("/api/bots/stream", {
        version: 2,
        revision: 1,
        bots: [{
          botId: "bot-beta",
          name: "Beta Curator",
          environment: { kind: "directory", path: FIXTURE_PROJECT_B.projectPath },
          sessionRefs: [],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [],
          missingSessionRefs: [],
        }],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Add sessions to Beta Curator" }));
    await waitFor(() => {
      expect(transport.subscriptions.map((subscription) => subscription.path)).toContainEqual(
        expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`),
      );
    });
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [FIXTURE_SESSIONS[0]]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Session Claude 01/ }));

    transport.responses.set("POST /api/bots/bot-beta/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-beta" }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add sessions" }));
    });

    expect(transport.requests.find((request) => request.path === "/api/bots/bot-beta/sessions")).toEqual({
      method: "POST",
      path: "/api/bots/bot-beta/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
      },
    });
    expect(screen.queryByRole("dialog", { name: "Add sessions to Beta Curator" })).not.toBeInTheDocument();
    unmount();
  });

  it("shows loading before the first project snapshot", () => {
    const { unmount } = setup();
    expect(screen.getByText(/loading projects/i)).toBeInTheDocument();
    unmount();
  });

  it("renders fed projects with their source badges and session counts", () => {
    const { transport, unmount } = setup();

    deliverProjects(transport);

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
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "false");
    expect(transport.subscriptions.map((open) => open.path)).toContainEqual(
      expect.stringContaining(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_A.projectPath)}`),
    );

    deliverSessions(transport);
    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Session Codex 01")).toBeInTheDocument();
    unmount();
  });

  it("keeps several projects expanded with independent subscriptions", () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));
    deliverProjectSessions(transport, FIXTURE_PROJECT_B.projectPath, [{
      sessionId: "sid-beta-01",
      source: "claude",
      title: "Beta session",
      lastEventAt: Date.now(),
      activity: "ready",
      capabilities: READ_ONLY_CAPABILITIES,
    }]);

    expect(screen.getByText("Session Claude 01")).toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ }));
    // Collapsing drops that project from the one inventory stream, which stays open for
    // the other. However many projects are unfolded, there is exactly one subscription.
    const inventory = transport.subscriptions
      .map((open) => open.path)
      .filter((path) => path.startsWith("/api/inventory/stream"));
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toContain(`projectPath=${encodeURIComponent(FIXTURE_PROJECT_B.projectPath)}`);
    expect(inventory[0]).not.toContain(encodeURIComponent(FIXTURE_PROJECT_A.projectPath));
    expect(screen.queryByText("Session Claude 01")).not.toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();

    unmount();
  });

  it("shows three sessions first and reveals ten more per click", () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    const manySessions = Array.from({ length: 24 }, (_, index) => ({
      sessionId: `sid-${index + 1}`,
      source: "codex",
      title: `Session ${String(index + 1).padStart(2, "0")}`,
      lastEventAt: Date.now() - index,
      activity: "ready",
      capabilities: READ_ONLY_CAPABILITIES,
    }));
    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, manySessions);

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

    deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, manySessions.slice(0, 2));
    expect(screen.getByText("Session 02")).toBeInTheDocument();
    expect(screen.queryByText("Session 03")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show .* more/ })).not.toBeInTheDocument();

    unmount();
  });

  it("mounts the selected thread while keeping its project sessions visible", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);

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
    const { transport, unmount } = setup();
    deliverProjects(transport);
    fireEvent.click(screen.getByRole("button", { name: /^Beta Project 1 session/ }));

    act(() => {
      transport.deliver("/api/inventory/stream", {
        projects: [FIXTURE_PROJECT_B, FIXTURE_PROJECT_A],
      });
    });

    expect(screen.getByRole("button", { name: /^Alpha Project 2 sessions/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Beta Project 1 session/ })).toHaveAttribute("aria-expanded", "true");
    unmount();
  });

  it("uses a modal project drawer on compact view and restores focus after dismissal", async () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveAttribute("open");

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveAttribute("open");

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    expect(drawer).toHaveAttribute("open");
    fireEvent(drawer, new Event("cancel", { cancelable: true }));
    expect(drawer).not.toHaveAttribute("open");
    await waitFor(() => expect(trigger).toHaveFocus());
    unmount();
  });

  it("closes the phone drawer when Canvas is chosen, because the canvas is behind it", () => {
    installViewport({ compact: true, hoverCapable: false });
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(drawer).toHaveAttribute("open");

    // Bots keeps its content inside the drawer, so the drawer stays.
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    expect(drawer).toHaveAttribute("open");

    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(drawer).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Canvas");
    unmount();
  });

  it("keeps compact navigation modal when a mouse or trackpad can hover", () => {
    installViewport({ compact: true, hoverCapable: true });
    const { transport, unmount } = setup();
    deliverProjects(transport);

    // The drawer is already open here. A transient peek layered over it would be two
    // navigations answering one pointer, so hovering the trigger changes nothing.
    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    fireEvent.pointerEnter(trigger);
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Agent navigation" }))
      .toHaveAttribute("open");
    // Width still owns composition: no pointer makes a compact layout grow a pinned column.
    expect(screen.queryByRole("complementary", { name: "Agent navigation" }))
      .not.toBeInTheDocument();
    unmount();
  });

  it("peeks the transient drawer on hover in a window too narrow to pin in", () => {
    vi.useFakeTimers();
    // The Agents window is 480pt wide, which is compact, and it is on a Mac, which hovers. Both
    // at once is the case that used to fall through to the touch story and ignore the mouse.
    installViewport({ compact: true, hoverCapable: true });
    storeSidebarPreferences({ open: false, width: 300, mode: "sessions" });
    const { transport, unmount } = setup();
    deliverProjects(transport);

    const trigger = screen.getByRole("button", { name: "Open agent navigation" });
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    const preview = screen.getByRole("complementary", { name: "Agent navigation preview" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // An overlay, never the pinned column, and never wide enough to hide the thread behind it.
    expect(screen.queryByRole("complementary", { name: "Agent navigation" }))
      .not.toBeInTheDocument();
    expect(preview).toHaveStyle({ width: "300px", maxWidth: "calc(100% - 3.5rem)" });

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    // Pressing commits to the modal drawer, and the peek is dropped rather than stacked under it.
    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Agent navigation" })).toHaveAttribute("open");
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" }))
      .not.toBeInTheDocument();

    unmount();
    vi.useRealTimers();
  });

  it("previews on desktop hover, pins on click, and restores the saved width", () => {
    vi.useFakeTimers();
    installViewport({ compact: false, hoverCapable: true });
    storeSidebarPreferences({ open: false, width: 300, mode: "sessions" });
    const first = setup();
    deliverProjects(first.transport);

    const trigger = screen.getByRole("button", { name: "Pin agent sidebar" });
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("complementary", { name: "Agent navigation preview" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Agent views" }).parentElement)
      .toHaveClass("agent-window-titlebar-sidebar-leading");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 300,
      mode: "sessions",
    });

    fireEvent.pointerLeave(trigger);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("complementary", { name: "Agent navigation preview" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Pin agent sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeInTheDocument();

    const separator = screen.getByRole("separator", { name: "Resize agent sidebar" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "316");
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 316,
      mode: "sessions",
    });

    firePointerEvent(separator, "pointerdown", { pointerId: 7, clientX: 316 });
    firePointerEvent(separator, "pointermove", { pointerId: 7, clientX: 356 });
    expect(separator).toHaveAttribute("aria-valuenow", "356");
    firePointerEvent(separator, "pointerup", { pointerId: 7, clientX: 356 });
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: true,
      width: 356,
      mode: "sessions",
    });

    first.unmount();
    const restored = setup();
    expect(screen.getByRole("separator", { name: "Resize agent sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "356",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close agent navigation" }));
    expect(screen.getByRole("button", { name: "Pin agent sidebar" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("agent-panel.sidebar.preferences")!)).toEqual({
      open: false,
      width: 356,
      mode: "sessions",
    });
    restored.unmount();
    vi.useRealTimers();
  });

  it("gives the thread a header slot for its own controls", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    expect(screen.getByTestId("activity-feed")).toHaveAttribute(
      "data-controls-host",
      "attached",
    );
    unmount();
  });

  it("drops the centring spacer so a long title uses the full row", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

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
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    // Progress and ready are carried by the header icon; the sentence is for
    // assistive tech only. A permanent 45px band for one button is what this
    // replaced.
    expect(screen.getByRole("status")).toHaveClass("sr-only");

    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    unmount();
  });

  it("keeps failure and exit visible, because those need reading", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    emitTerminalState({ kind: "error", message: "the session is active elsewhere" });
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude terminal unavailable: the session is active elsewhere",
    );
    unmount();
  });

  it("shows the terminal launcher only on a thread", () => {
    const { transport, unmount } = setup();

    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();
    deliverProjects(transport);
    deliverSessions(transport);
    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("opens with exact context inside the main column and sends no native terminal message", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: "/projects/alpha",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    expect(fake.posted.some((message) =>
      (message as { t?: string }).t?.startsWith("agent-terminal-"))).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Opening Claude");
    const terminal = screen.getByRole("region", { name: "Claude terminal" });
    // The pane belongs to the session's own column, which fills `main`, rather than being a band
    // of the shell's beneath it. What this guards is unchanged: it is in the content column and
    // not in the sidebar.
    expect(screen.getByRole("main")).toContainElement(terminal);
    const mainColumn = screen.getByRole("main").parentElement!;
    expect(screen.getByLabelText("Agent navigation").parentElement).toContainElement(mainColumn);
    unmount();
  });

  it("updates the band for sidecar error and ended states", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    emitTerminalState({ kind: "error", message: "terminal-conflict" });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal unavailable: terminal-conflict");

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({ kind: "ended", exitStatus: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal ended");
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("swaps the composer's field for the thread's own terminal, one or the other", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    // The field is what a session opens with: it is the surface every session has.
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude session terminal" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));

    // The session id, not a pane name. Which tmux pane that is -- the one a live process runs in,
    // or one started to resume the id -- is the sidecar's to answer, and it is the only side that
    // can: the panel would have to ask, and get the same null for a session running outside tmux
    // as for a session not running at all.
    expect(terminalPaneMock.composerContext).toEqual({
      kind: "session-tmux",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    expect(screen.getByRole("region", { name: "Claude session terminal" })).toBeInTheDocument();
    // Instead of the field, not above it: two ways of typing at one session, and the band spends
    // its height on whichever is in use rather than on both.
    expect(screen.queryByLabelText("Claude composer text")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide the terminal" }));
    expect(screen.queryByRole("region", { name: "Claude session terminal" }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    unmount();
  });

  it("unmounts the Agent Feed terminal when the viewer closes it", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Claude terminal" }));
    expect(screen.queryByRole("region", { name: "Claude terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("removes the old pane before replacing the selected thread", () => {
    const { fake, transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    fireEvent.click(screen.getByText("Session Codex 01"));

    expect(screen.queryByRole("region", { name: "Claude terminal" })).not.toBeInTheDocument();
    expect(fake.posted.some((message) =>
      (message as { t?: string }).t?.startsWith("agent-terminal-"))).toBe(false);
    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-session-id", "sid-codex-01");
    unmount();
  });

  it("opens the replacement session with its own provider context", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: "/projects/alpha",
      source: "codex",
      sessionId: "sid-codex-01",
    });
    unmount();
  });

  it("ignores stale ready after navigation and session replacement", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    const oldContext = terminalPaneMock.context!;
    const oldOnState = terminalPaneMock.onState!;
    fireEvent.click(screen.getByText("Session Codex 01"));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex terminal" }));

    act(() => oldOnState(oldContext, {
      kind: "ready",
      descriptor: {
        terminalId: "stale-terminal",
        ptySessionName: "stale-pty",
        pid: 41,
        columns: 80,
        rows: 24,
      },
    }));
    expect(screen.getByRole("status")).toHaveTextContent("Opening Codex");

    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-2",
        ptySessionName: "agent-resume-codex-sid-codex-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Codex terminal ready");
    unmount();
  });

  it("creates a Pi session, sends through the composer, and answers extension UI", async () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    await createPiSession(transport);

    expect(screen.getByTestId("activity-feed")).toHaveAttribute("data-source", "pi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("SDK-authored Pi session");
    expect(screen.queryByRole("button", { name: /Pi terminal/i })).not.toBeInTheDocument();
    transport.responses.set("POST /api/agent-sessions/pi/pi-1/messages", {
      status: 202,
      body: JSON.stringify({ requestId: "r-send", delivery: "immediate" }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message Pi" }), { target: { value: "Inspect the repo" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/pi/pi-1/messages",
      body: { text: "Inspect the repo", delivery: "next" },
    });

    // Prompts ride the thread's own stream, so they cannot outlive the thread that asked them.
    act(() => {
      transport.deliver("/timeline", {
        type: "ui",
        event: {
          type: "request",
          request: { requestId: "ui-1", kind: "confirm", title: "Proceed?", message: "Run it", expectsResponse: true },
        },
      });
      for (let index = 0; index < 12; index += 1) {
        transport.deliver("/timeline", {
          type: "ui",
          event: {
            type: "request",
            request: { requestId: `notice-${index}`, kind: "status", key: "working", message: `Status ${index}`, expectsResponse: false },
          },
        });
      }
    });
    expect(screen.getByRole("dialog", { name: "Proceed?" })).toBeInTheDocument();

    transport.responses.set("POST /api/agent-sessions/pi/pi-1/ui/ui-1", { status: 200, body: "{}" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/pi/pi-1/ui/ui-1",
      body: { value: true },
    });
    act(() => {
      transport.deliver("/timeline", { type: "ui", event: { type: "dismiss", requestId: "ui-1" } });
    });
    expect(screen.queryByRole("dialog", { name: "Proceed?" })).not.toBeInTheDocument();
    unmount();
  });

  it("renders the message composer as a roomy, padded field rather than a single cramped row", async () => {
    const { transport, fake, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);

    await createPiSession(transport);

    const field = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(field.className).toContain("min-h-12");
    expect(field.className).toContain("px-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    // The ring is on the box around the field rather than the field itself, because the box also
    // holds the images the composer is carrying and they are inside the same border.
    expect(field.parentElement?.className).toContain("focus-within:ring-2");
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
      const { transport, fake, unmount } = setup();
      deliverProjects(transport);
      deliverSessions(transport);

      await createPiSession(transport);

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

  it("is focusable before the first status, then disabled with the host's reason", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);

    // Focusable before any status: the watch is focus-gated, so a field disabled "until a status
    // arrives" could never be focused and the status would never arrive.
    expect(screen.getByLabelText("Claude composer text")).toBeEnabled();

    focusComposer(transport);
    deliverStatus(transport, { en: false, r: "terminal-only" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "running in a terminal",
    );
    // The only explicit action left is Enter, and it cannot fire without a window.
    expect(screen.getByRole("button", { name: "Send to Claude's composer" })).toBeDisabled();
    unmount();
  });

  it("does not read as unavailable before the watch has said anything", () => {
    // The watch is focus-gated, so an unfocused session has no status, and keying the placeholder
    // on `enabled` alone made every one of them announce "Composer unavailable" -- most visibly on
    // a passively-watched thread, where nothing ever focuses the field. The field is usable here,
    // and the placeholder has to say so.
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    const field = screen.getByLabelText("Claude composer text");
    expect(field).toBeEnabled();
    expect(field).toHaveAttribute("placeholder", expect.stringContaining("Type into Claude"));

    focusComposer(transport);
    deliverStatus(transport, { en: false, r: "no-window" });

    expect(screen.getByLabelText("Claude composer text"))
      .toHaveAttribute("placeholder", "Composer unavailable");
    unmount();
  });

  it("names the two-instance case instead of leaving it as a bare unavailable", () => {
    // The host used to resolve this by picking the lowest-pid instance, which wrote into whichever
    // Claude launched first. Now it refuses and says so, and the viewer's fix -- close the session in
    // one of them -- has to be readable from the notice alone.
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    focusComposer(transport);

    deliverStatus(transport, { en: false, r: "multiple-instances" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "more than one Claude instance",
    );
    unmount();
  });

  it("prefills from the window on focus and auto-syncs every edit after a debounce", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    deliverStatus(transport, { tx: "half-written prompt" });

    expect(field).toBeEnabled();
    expect(field).toHaveValue("half-written prompt");

    fireEvent.change(field, { target: { value: "review the diff" } });
    // No fill button anymore, and Return still never sends: the sync is automatic.
    expect(screen.queryByRole("button", { name: "Fill Claude's composer" })).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    // One burst of typing lands as one sync, 500ms after the last keystroke.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "review the diff",
    });
    unmount();
  });

  it("clearing the field is an edit, so deletions sync as the empty value", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "text to delete" });

    fireEvent.change(field, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "",
    });
    unmount();
  });

  it("retries a draft when the leased Claude window becomes active", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    // The lease is still being acquired. Typing is allowed, but the first debounce cannot send to
    // an off-Desktop window yet.
    deliverStatus(transport, { cur: false, tx: null });
    fireEvent.change(field, { target: { value: "sync after lease" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    // The host's lease status flips active. The debounce effect must wake up and retry the existing
    // unsynced draft without requiring another keystroke.
    deliverStatus(transport, { cur: true, tx: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "sync after lease",
    });
    unmount();
  });

  it("blur flushes an unsynced edit and unwatches, stopping the host's poll", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "about to leave" } });
    fireEvent.blur(field);

    // The flush lands before the stream closes, so nothing typed is lost. Closing the stream is
    // what releases the window's editing lease and stops the sidecar's poll.
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "about to leave",
    });
    expect(transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM))).toBe(false);
    unmount();
  });

  it("an echo of our own write marks the field in sync; an independent edit then lands", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "mid" } });
    // The host's write echo arrives while the draft is still "unsent": matching text means field and
    // window agree again, so a LATER independent edit must be adopted rather than guarded forever.
    deliverStatus(transport, { tx: "mid" });
    deliverStatus(transport, { tx: "edited directly in Claude" });

    expect(field).toHaveValue("edited directly in Claude");
    unmount();
  });

  it("does not overwrite an in-flight edit with a status that arrives while typing", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "mid-sentence" } });

    // The host re-resolves on a timer, so a status carrying the window's own text can land at any
    // moment. Adopting it here would delete what the viewer just typed.
    deliverStatus(transport, { tx: "whatever the window holds" });

    expect(field).toHaveValue("mid-sentence");
    unmount();
  });

  it("does not overwrite newer typing with a stale sync result that resolves late", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    // The sidecar answers the write with what the field read back, which is already stale by the
    // time it resolves: the user kept typing while Chromium settled the value.
    answerComposer(transport, "sync", { text: "first burst" });
    fireEvent.change(field, { target: { value: "first burst" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Adopting the read-back here would truncate the field back to "first burst" mid-keystroke.
    fireEvent.change(field, { target: { value: "first burst, then more" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(field).toHaveValue("first burst, then more");
    unmount();
  });

  it("the Enter button actually sends by filling and pressing Return", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    const sendButton = screen.getByRole("button", { name: "Send to Claude's composer" });
    expect(sendButton).toBeDisabled();

    fireEvent.change(field, { target: { value: "run the tests" } });
    expect(sendButton).toBeEnabled();

    fireEvent.click(sendButton);
    expect(lastComposerCall(transport, "submit")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "run the tests",
    });
    unmount();
  });

  it("an off-Desktop window is prefilled by one automatic round trip", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    answerComposer(transport, "read", { text: "found on the other Desktop" });
    deliverStatus(transport, { cur: false, tx: null });

    // No bring-window button: the round trip is the flow now, fired once on focus.
    expect(screen.queryByRole("button", { name: "Load from Claude window" })).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(composerCalls(transport, "read")).toHaveLength(1);
    await waitFor(() => expect(field).toHaveValue("found on the other Desktop"));
    unmount();
  });

  it("keeps the field editable while an off-Desktop prefill is in flight", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    deliverStatus(transport, { cur: false, tx: null });

    expect(lastComposerCall(transport, "read")).toMatchObject({ sessionId: "sid-claude-01" });
    expect(field).toBeEnabled();
    fireEvent.change(field, { target: { value: "typing while Claude is being read" } });
    expect(field).toHaveValue("typing while Claude is being read");
    unmount();
  });

  it("keeps off-Desktop typing local until Send performs one submit", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    answerComposer(transport, "read", { text: "draft from Claude" });
    deliverStatus(transport, { cur: false, tx: null });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(field, { target: { value: "finish without moving the window" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Send to Claude's composer" }));
    expect(lastComposerCall(transport, "submit")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "finish without moving the window",
    });
    unmount();
  });

  it("a failed round trip says a missing window mover is not something to retry", async () => {
    // Moving another application's window between Desktops uses a private native operation. If the
    // current macOS no longer exposes it, the automatic round trip fails once and the caption reports
    // an unavailable capability rather than inviting an endless retry.
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    focusComposer(transport);

    answerComposer(
      transport,
      "read",
      { error: { code: "window-composer-failed", message: "window-mover-unavailable" } },
      503,
    );
    deliverStatus(transport, { cur: false, tx: null });

    await waitFor(() =>
      expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
        "does not expose the window mover",
      ));
    unmount();
  });

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
    expect(screen.getByLabelText("Claude window composer").className).toContain("px-6");
    // The resting height and padding are the load-bearing part of the redesign: a multi-line draft
    // must have room to breathe before it even begins to grow. `min-h-12` (a two-line resting field)
    // and the `px-4 py-3` gutter are the contract; the auto-grow cap stops the field from chasing a
    // wall of text forever.
    expect(field.className).toContain("min-h-12");
    expect(field.className).toContain("px-4");
    expect(field.className).toContain("py-3");
    expect(field.className).toContain("max-h-48");
    // The ring is on the box around the field rather than the field itself, because the box also
    // holds the images the composer is carrying and they are inside the same border.
    expect(field.parentElement?.className).toContain("focus-within:ring-2");
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

  /**
   * Whether the composer stream is open. The question mirror shares it with the composer field,
   * because the sidecar reads both halves in one pass and sends them down one stream.
   */
  function questionStreamOpen(transport: FakeHttpTransport): boolean {
    return transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM));
  }

  function deliverQuestionStatus(
    transport: FakeHttpTransport,
    overrides: Record<string, unknown> = {},
  ) {
    const { en = true, pr = true, sel = [], ot = null, sb = null, r = null } = overrides;
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        question: {
          sessionId: "sid-claude-01",
          enabled: en,
          reason: r,
          present: pr,
          selectedIndices: sel,
          otherText: ot,
          submitEnabled: sb,
        },
      });
    });
  }

  /** Every question action the panel posted, in order. */
  function questionCalls(transport: FakeHttpTransport) {
    return transport.requests.filter((request) => request.path === "/api/window/question/action");
  }

  function lastQuestionCall(transport: FakeHttpTransport) {
    return questionCalls(transport).at(-1)?.body;
  }

  /** Pre-seeds the post-action state a question action answers with. */
  function answerQuestion(transport: FakeHttpTransport, overrides: Record<string, unknown> = {}) {
    const { en = true, pr = true, sel = [], ot = null, sb = null, r = null } = overrides;
    transport.responses.set("POST /api/window/question/action", {
      status: 200,
      body: JSON.stringify({
        sessionId: "sid-claude-01",
        enabled: en,
        reason: r,
        present: pr,
        selectedIndices: sel,
        otherText: ot,
        submitEnabled: sb,
      }),
    });
  }

  function openQuestion(question: unknown) {
    act(() => feedMock.emitQuestion?.(question));
  }

  it("renders the panel from the feed JSON: question, options, Other, and every action", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
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
    expect(questionStreamOpen(transport)).toBe(true);
    unmount();
  });

  it("posts a select action on choice and adopts the post-action read-back", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    fireEvent.click(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" }));
    const action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ sessionId: "sid-claude-01", kind: "select", option: 1, desired: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    unmount();
  });

  it("renders multi-select as checkboxes and un-checks by pressing with the desired state", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(MULTI_QUESTION);

    expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(3);
    const dark = screen.getByRole("checkbox", { name: "Dark mode" });
    // The panel answers the press with the post-action state: our option, checked, alongside a
    // selection made in the window itself.
    answerQuestion(transport, { sel: [0, 1], sb: true });
    fireEvent.click(dark);
    let action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ kind: "select", option: 0, desired: true });

    // The host reports it landed, pre-checked alongside a host-side selection.
    await act(async () => {
      await Promise.resolve();
    });
    expect(dark).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).toBeChecked();

    // Un-checking a box asks the host to press it toward unchecked.
    fireEvent.click(dark);
    action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ kind: "select", option: 0, desired: false });
    unmount();
  });

  it("debounces Other typing into an other action, and other-empty is a real intent", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    const other = screen.getByLabelText("Other answer");
    fireEvent.change(other, { target: { value: "Deploy a different release" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastQuestionCall(transport)).toMatchObject({
      sessionId: "sid-claude-01",
      kind: "other",
      text: "Deploy a different release",
    });

    // Clearing the input pushes the empty value, matching the composer's deletion rule.
    fireEvent.change(other, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastQuestionCall(transport)).toMatchObject({ kind: "other", text: "" });
    unmount();
  });

  it("posts submit, skip, and dismiss with no payload", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { sel: [0], sb: true });

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "submit" });
    // Each explicit action holds the controls until its result lands; resolve
    // between clicks so the next control is enabled again.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "skip" });
    // Skip keeps the panel up in the window until Claude records it; only Dismiss
    // ends the test, so the mirror stays mounted.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "dismiss" });
    unmount();
  });

  it("adopts pre-checked selection from the window's live state", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(MULTI_QUESTION);
    deliverQuestionStatus(transport, { sel: [0, 2], sb: true });

    expect(screen.getByRole("checkbox", { name: "Dark mode" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Analytics" })).toBeChecked();
    unmount();
  });

  it("hides the mirror when the host reports the panel is gone, and closes the watch", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { pr: false });

    expect(screen.queryByLabelText("Claude question")).toBeNull();
    unmount();
  });

  it("unwatches when the question closes in the feed", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    expect(questionStreamOpen(transport)).toBe(true);

    openQuestion(null);
    expect(questionStreamOpen(transport)).toBe(false);
    unmount();
  });

  it("surfaces the host's reason when the window is unreachable", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { en: false, r: "terminal-only", pr: null });

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "running in a terminal",
    );
    expect(screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" })).toBeDisabled();
    unmount();
  });

  it("shows the option description when View options is toggled", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    expect(screen.queryByText("Add a ledger entry for a new application release.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View question options" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "view-options" });
    expect(screen.getByText("Add a ledger entry for a new application release.")).toBeInTheDocument();
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

/**
 * A Claude session running in a terminal takes a different composer from one running in a window.
 *
 * The distinction is not cosmetic. The window band mirrors an actual text field, so it has a draft
 * to read back, an Enter to press in someone else's app, and a Desktop to bring the window from. A
 * terminal session has none of that: there is one thing to do, which is hand it a turn.
 */
describe("terminal session composer", () => {
  const INPUT_PATH = "/api/sessions/claude/sid-claude-01/input";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  function setupInput(status: Record<string, unknown>, receipt?: Record<string, unknown>) {
    const harness = setup();
    harness.transport.responses.set(`GET ${INPUT_PATH}`, {
      status: 200,
      body: JSON.stringify(status),
    });
    if (receipt) {
      harness.transport.responses.set(`POST ${INPUT_PATH}`, {
        status: 200,
        body: JSON.stringify(receipt),
      });
    }
    return harness;
  }

  it("replaces the window composer for a session running in a terminal", async () => {
    const { transport, unmount } = setupInput({ available: true, entrypoint: "cli", reason: null });
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeInTheDocument();
    expect(screen.queryByLabelText("Claude composer text")).toBeNull();
    unmount();
  });

  it("keeps the window composer for a Desktop session, which has a field to mirror", async () => {
    const { transport, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    openClaudeThread(transport);
    await waitFor(() => {
      expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Message this terminal session")).toBeNull();
    unmount();
  });

  it("posts the turn to the session's inbox and clears the draft", async () => {
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: true, reason: null },
    );
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.change(field, { target: { value: "run the tests" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send to the terminal session"));
      await Promise.resolve();
    });
    expect(transport.requests).toContainEqual({
      method: "POST",
      path: INPUT_PATH,
      body: { text: "run the tests" },
    });
    await waitFor(() => {
      expect((field as HTMLTextAreaElement).value).toBe("");
    });
    unmount();
  });

  it("keeps the draft when the session refused it, and says why", async () => {
    // The turn is the expensive thing the viewer typed on a phone. Losing it because a terminal
    // was closed is the failure worth designing against.
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: false, reason: "unreachable" },
    );
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    fireEvent.change(field, { target: { value: "still here" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send to the terminal session"));
      await Promise.resolve();
    });
    expect((field as HTMLTextAreaElement).value).toBe("still here");
    await waitFor(() => {
      expect(screen.getByText(/stopped listening/)).toBeInTheDocument();
    });
    unmount();
  });

  it("re-asks on focus, so a session started after the panel opened becomes writable", async () => {
    const { transport, unmount } = setupInput({
      available: false,
      entrypoint: "cli",
      reason: "not-running",
    });
    openClaudeThread(transport);
    const field = await screen.findByLabelText("Message this terminal session");
    expect(field).toBeDisabled();
    transport.responses.set(`GET ${INPUT_PATH}`, {
      status: 200,
      body: JSON.stringify({ available: true, entrypoint: "cli", reason: null }),
    });
    await act(async () => {
      fireEvent.focus(field);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Message this terminal session")).not.toBeDisabled();
    });
    unmount();
  });

  it("falls through a refused window composer to the already-open Agent Feed terminal", async () => {
    const { transport, fake, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    openClaudeThread(transport);
    const windowField = await screen.findByLabelText("Claude composer text");

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    fireEvent.focus(windowField);
    fireEvent.change(windowField, { target: { value: "keep this draft" } });
    act(() => transport.deliver(COMPOSER_STREAM, {
      composer: {
        sessionId: "sid-claude-01",
        enabled: false,
        reason: "terminal-only",
        onActiveDesktop: true,
        composerText: "",
      },
    }));

    const terminalField = await screen.findByLabelText("Message through Agent Feed terminal");
    await waitFor(() => expect(terminalField).toHaveValue("keep this draft"));
    expect(screen.getByLabelText("Agent Feed terminal composer")).toHaveTextContent(
      "Sending through the open Agent Feed terminal",
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send through Agent Feed terminal"));
    });
    expect(transport.requests).toContainEqual({
      method: "POST",
      path: "/api/terminals/terminal-1/input",
      body: { data: "\u001b[200~keep this draft\u001b[201~\r", encoding: "utf8" },
    });
    await waitFor(() => expect(terminalField).toHaveValue(""));
    // The window composer's stream closed when the field went away, which is what releases the
    // window's editing lease and stops the sidecar's poll.
    expect(transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM))).toBe(false);
    unmount();
  });

  it("keeps an available native window ahead of the Agent Feed terminal", async () => {
    const { transport, fake, unmount } = setupInput({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
    openClaudeThread(transport);
    const windowField = await screen.findByLabelText("Claude composer text");
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    fireEvent.focus(windowField);
    act(() => transport.deliver(COMPOSER_STREAM, {
      composer: {
        sessionId: "sid-claude-01",
        enabled: true,
        reason: null,
        onActiveDesktop: true,
        composerText: "native draft",
      },
    }));

    expect(screen.getByLabelText("Claude composer text")).toHaveValue("native draft");
    expect(screen.queryByLabelText("Message through Agent Feed terminal")).toBeNull();
    unmount();
  });

  it("keeps an available CLI inbox ahead of the Agent Feed terminal", async () => {
    const { transport, unmount } = setupInput(
      { available: true, entrypoint: "cli", reason: null },
      { delivered: true, reason: null },
    );
    openClaudeThread(transport);
    await screen.findByLabelText("Message this terminal session");
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });

    expect(screen.getByLabelText("Message this terminal session")).toBeEnabled();
    expect(screen.queryByLabelText("Message through Agent Feed terminal")).toBeNull();
    unmount();
  });

  it("uses the Agent Feed terminal when the detected CLI inbox is unavailable", async () => {
    const { transport, unmount } = setupInput({
      available: false,
      entrypoint: "cli",
      reason: "no-inbox",
    });
    openClaudeThread(transport);
    expect(await screen.findByLabelText("Message this terminal session")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });

    expect(await screen.findByLabelText("Message through Agent Feed terminal")).toBeEnabled();
    unmount();
  });
});
