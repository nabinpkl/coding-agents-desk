/**
 * The four modules the App-shell tests mock, as factories the `vi.mock` calls return.
 *
 * Deliberately free of any import of `AgentPanelApp`: a mock factory that reached the App would
 * reach `ActivityFeed` through it while that module's own mock was still being defined, and the
 * collection deadlocks with no error. The fixtures and the render helper live next door in
 * `agentPanelAppHarness.tsx`, which is allowed to import the App because nothing mocks it.
 */

// Shared state between the mocked feed and the tests: the tests set the
// feed's open question through this emitter, exactly as the real feed reports it.
export const feedMock = {
  emitQuestion: null as ((question: unknown) => void) | null,
};

export const terminalPaneMock = {
  composerContext: null as Record<string, unknown> | null,
  // Whether the pane was handed something to be a share of, rather than left to ask the viewport.
  // Recorded because a session rendered inside a Bot card must never ask the viewport: a share of
  // the screen is more than the whole card.
  composerHasBasis: null as boolean | null,
  context: null as Record<string, unknown> | null,
  /** The data source the non-composer pane was handed, which says which machine it attaches on. */
  feed: null as unknown,
  onState: null as ((context: Record<string, unknown>, state: Record<string, unknown>) => void) | null,
};

// Mock ActivityFeed so Milkdown/ProseMirror never loads in jsdom.
export async function activityFeedModule() {
  const { useEffect } = await import("react");
  const { useDataSource } = await import("@/features/activity-feed/data-source/AgentDataSourceContext");
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
        () =>
          dataSource.subscribeSessionEvents({ source, sessionId, mode: "nice" }, 0, {
            onEvent: () => {},
            onSnapshot: () => {},
          }),
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
    // What a session the catalog has not listed yet shows in place of its feed.
    EmptyFeed: ({ text = "no events" }: { text?: string }) => <div data-testid="empty-feed">{text}</div>,
  };
}

// App-shell tests exercise ownership and placement. The renderer itself has a focused test with a
// fake xterm, so jsdom does not need a canvas merely because one shell test opens the pane.
export function terminalPaneModule() {
  return {
    AgentTerminalPane: ({
      feed,
      context,
      onState,
      heightBasis,
    }: {
      feed?: unknown;
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
        terminalPaneMock.feed = feed;
        terminalPaneMock.onState = onState;
      }
      const provider = context.source === "claude" ? "Claude" : context.source === "codex" ? "Codex" : "Opencode";
      return <section aria-label={`${provider}${context.kind === "session-tmux" ? " session" : ""} terminal`} />;
    },
  };
}

// Mock the Markdown renderer (used by ActivityFeed; mocked so its
// marked/shiki/katex deps never load under jsdom if pulled in transitively).
export function markdownModule() {
  return {
    Markdown: ({ content }: { content: string }) => <div data-testid="markdown-view">{content}</div>,
  };
}

// Mock DiffBlock (uses next-themes and @git-diff-view which don't run in jsdom).
export function diffBlockModule() {
  return {
    DiffBlock: () => <div data-testid="diff-block" />,
  };
}
