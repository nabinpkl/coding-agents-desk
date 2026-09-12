import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// Same jsdom-unsafe deps the other feed-level tests stub.
vi.mock("@/features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-view">{content}</div>
  ),
}));
vi.mock("@/features/activity-feed/blocks/DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  // The feed is virtualized, and a virtualizer given a zero-height viewport renders no
  // rows at all -- which in jsdom is every element. These tests are about what the rows
  // do, so give the scroller a viewport to render into.
  // The virtualizer measures its scroller with `offsetHeight`, which jsdom pins at zero.
  for (const [name, value] of [["offsetWidth", 900], ["offsetHeight", 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reflect rather than `delete`: both are declared readonly on HTMLElement.
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
});

function durable(index: number, text: string): ActivityEvent {
  return {
    id: `claude:line:${index}`,
    index,
    otherModeIndex: index,
    revision: 0,
    phase: "complete",
    ts: 1000 + index,
    type: "assistant",
    messageId: `msg_durable_${index}`,
    blocks: [{ kind: "text", text }],
  };
}

/** The mirror's third row, which on a real thread is nowhere near transcript line 3. */
const liveRow: ActivityEvent = {
  id: "claude-live:msg_live",
  index: 3,
  otherModeIndex: 3,
  revision: 0,
  phase: "streaming",
  ts: 9000,
  type: "assistant",
  messageId: "msg_live",
  blocks: [{ kind: "text", text: "the message being written" }],
};

const systemRow: ActivityEvent = {
  id: "claude:line:system",
  index: 0,
  otherModeIndex: 0,
  revision: 0,
  phase: "complete",
  ts: 1000,
  type: "system",
  blocks: [{ kind: "text", text: "system bootstrap detail" }],
};

/**
 * The live tail's index is a position in the sidecar's live projection, counted per
 * session from the mirror's first row. A durable event's index is a line in the
 * transcript. Both are small integers on the same session and they overlap constantly,
 * so the feed must not key anything on the two of them together.
 */
describe("live tail collapse state", () => {
  it("hides a System-only Nice snapshot but keeps the Raw escape hatch", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const controlsHost = document.createElement("div");
    document.body.append(controlsHost);
    const view = render(
      <DataSourceProvider source={source}>
        <ActivityFeed
          source="claude"
          sessionId="sid-system"
          mode="nice"
          onToggleMode={() => {}}
          showCacheHits={false}
          onToggleCacheHits={() => {}}
          controlsHost={controlsHost}
        />
      </DataSourceProvider>,
    );

    act(() => {
      transport.deliver("sid-system", {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 1,
          mode: "nice",
          events: [systemRow],
          windowStart: 0,
          total: 1,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });

    expect(await screen.findByText("no content events")).toBeInTheDocument();
    expect(screen.queryByText("system bootstrap detail")).toBeNull();
    expect(screen.getByRole("button", { name: "show every line" })).toBeInTheDocument();
    view.unmount();
    controlsHost.remove();
  });

  it("does not share collapse state with the transcript row at the same index", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    render(
      <DataSourceProvider source={source}>
        <ActivityFeed
          source="claude"
          sessionId="sid-collide"
          mode="nice"
          onToggleMode={() => {}}
          showCacheHits={false}
          onToggleCacheHits={() => {}}
          controlsHost={null}
        />
      </DataSourceProvider>,
    );

    act(() => {
      transport.deliver("sid-collide", {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 1,
          mode: "nice",
          events: [durable(3, "a durable message")],
          windowStart: 0,
          total: 1,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });
    act(() => {
      transport.deliver("sid-collide", { type: "tail", event: liveRow });
    });

    await waitFor(() => expect(screen.getAllByTestId("markdown-view")).toHaveLength(2));

    // Collapse the durable row. Sharing one keyed set meant this also folded the live
    // row, hiding the message the reader was watching arrive. Assert on the BODY, not on
    // the text: a collapsed row keeps a one-line preview of its own content, so the
    // message being written is still findable by text with the bug present.
    const durableToggle = screen
      .getAllByRole("button")
      .find((button) => (button.getAttribute("title") ?? "").startsWith("#3"));
    expect(durableToggle).toBeDefined();
    act(() => durableToggle!.click());

    // One body left, and it is not the durable one. Sharing the set folded both, which
    // leaves none. Identity rather than content: the live row reveals its text on a
    // timer, so its body is legitimately still empty this early.
    const open = screen.getAllByTestId("markdown-view");
    expect(open).toHaveLength(1);
    expect(open.map((body) => body.textContent)).not.toContain("a durable message");
  });

  it("collapses the live row on its own toggle", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    render(
      <DataSourceProvider source={source}>
        <ActivityFeed
          source="claude"
          sessionId="sid-own"
          mode="nice"
          onToggleMode={() => {}}
          showCacheHits={false}
          onToggleCacheHits={() => {}}
          controlsHost={null}
        />
      </DataSourceProvider>,
    );

    act(() => {
      transport.deliver("sid-own", {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 1,
          mode: "nice",
          events: [durable(3, "a durable message")],
          windowStart: 0,
          total: 1,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });
    act(() => {
      transport.deliver("sid-own", { type: "tail", event: liveRow });
    });

    const liveToggle = await screen.findByLabelText(/, streaming/);
    // Two bodies on screen: the durable row's and the live one's. A collapsed row keeps
    // its heading and one-line preview, so the body is what actually goes away.
    expect(screen.getAllByTestId("markdown-view")).toHaveLength(2);

    act(() => liveToggle.click());

    expect(screen.getAllByTestId("markdown-view")).toHaveLength(1);
    // ...and the one still open is the durable row beside it, untouched.
    expect(screen.getByTestId("markdown-view").textContent).toBe("a durable message");
  });
});
