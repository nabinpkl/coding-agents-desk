import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown-view">{content}</div>,
}));

const VIEWPORT = 800;
const CONTENT = 10000;
const END = CONTENT - VIEWPORT;
const SESSION = "sid-follow";

beforeEach(() => {
  // jsdom has no layout: the follower reads how far from the end the reader is off these.
  for (const [name, value] of [
    ["offsetWidth", 900],
    ["offsetHeight", VIEWPORT],
    ["clientHeight", VIEWPORT],
    ["scrollHeight", CONTENT],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  for (const name of ["offsetWidth", "offsetHeight", "clientHeight", "scrollHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

function durable(index: number): ActivityEvent {
  return {
    id: `claude:line:${index}`,
    index,
    otherModeIndex: index,
    revision: 0,
    phase: "complete",
    ts: 1000 + index,
    type: "assistant",
    messageId: `msg_${index}`,
    blocks: [{ kind: "text", text: `line ${index}` }],
  };
}

describe("following the tail of a transcript", () => {
  // A session's first prompt is queued before the transcript has anything in it, so the feed has
  // something to follow while it still draws "loading". The scroller mounts only when rows arrive,
  // and a follower that attached on the first of those renders never received a wheel: every
  // scroll up read as layout and snapped back. Reported 2026-10-18 on a Claude card after a handover.
  it("lets a wheel up leave the tail when the scroller mounted after a queued prompt", () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = { status: 200, body: JSON.stringify({ events: [], windowStart: 0 }) };
    const view = render(
      <DataSourceProvider source={new SidecarDataSource(transport)}>
        <ActivityFeed
          source="claude"
          sessionId={SESSION}
          mode="nice"
          onToggleMode={() => {}}
          showCacheHits={false}
          onToggleCacheHits={() => {}}
          controlsHost={null}
          queuedPrompts={[{ id: "q1", text: "the handover brief", images: 0, sentAt: 1 }]}
        />
      </DataSourceProvider>,
    );
    expect(view.container.querySelector("div.overflow-y-auto")).toBeNull();

    act(() => {
      transport.deliver(SESSION, {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 1,
          mode: "nice",
          events: Array.from({ length: 30 }, (_, index) => durable(index)),
          windowStart: 0,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });
    const scroller = view.container.querySelector<HTMLDivElement>("div.overflow-y-auto");
    if (!scroller) throw new Error("the feed rendered no scroller");
    act(() => {
      scroller.scrollTop = END;
      fireEvent.scroll(scroller);
    });
    expect(screen.queryByLabelText("scroll to bottom")).toBeNull();

    act(() => {
      fireEvent.wheel(scroller, { deltaY: -120 });
      scroller.scrollTop = END - 600;
      fireEvent.scroll(scroller);
    });
    expect(scroller.scrollTop).toBe(END - 600);
    expect(screen.getByLabelText("scroll to bottom")).toBeInTheDocument();
    view.unmount();
  });
});
