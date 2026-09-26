import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// Same jsdom-unsafe deps the other feed-level tests stub.
vi.mock("@/features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown-view">{content}</div>,
}));
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  for (const [name, value] of [["offsetWidth", 900], ["offsetHeight", 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
});

const row: ActivityEvent = {
  id: "claude:line:0",
  index: 0,
  otherModeIndex: 0,
  revision: 0,
  phase: "complete",
  ts: 1000,
  type: "assistant",
  blocks: [{ kind: "text", text: "the turn before the context was rewritten" }],
};

function mount(sessionId: string) {
  const transport = new FakeHttpTransport();
  const controlsHost = document.createElement("div");
  document.body.append(controlsHost);
  const view = render(
    <DataSourceProvider source={new SidecarDataSource(transport)}>
      <ActivityFeed
        source="claude"
        sessionId={sessionId}
        mode="nice"
        onToggleMode={() => {}}
        showCacheHits={false}
        onToggleCacheHits={() => {}}
        controlsHost={controlsHost}
      />
    </DataSourceProvider>,
  );
  act(() => {
    transport.deliver(sessionId, {
      type: "timeline",
      envelope: {
        kind: "snapshot",
        sequence: 1,
        mode: "nice",
        events: [row],
        windowStart: 0,
        total: 1,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      },
    });
  });
  return { transport, view, controlsHost };
}

describe("compacting notice", () => {
  it("says the context is being rewritten, and stops saying it when that ends", async () => {
    // The thing it answers: a compaction adds no transcript row until it lands and puts nothing in
    // the live tail, so for the two to four minutes it takes the thread looks exactly like one
    // whose turn is over.
    const { transport, view, controlsHost } = mount("sid-compacting");
    expect(screen.queryByText("Compacting the context")).toBeNull();

    act(() => transport.deliver("sid-compacting", { type: "compacting", active: true }));
    expect(await screen.findByText("Compacting the context")).toBeInTheDocument();

    act(() => transport.deliver("sid-compacting", { type: "compacting", active: false }));
    expect(screen.queryByText("Compacting the context")).toBeNull();

    view.unmount();
    controlsHost.remove();
  });

  it("shows the summary being written under the notice, and lets the reader fold it away", async () => {
    // It used to stream into the thread as a live row and sat on top of the compaction banner; it
    // now streams under the notice instead, and goes when the compaction lands.
    const { transport, view, controlsHost } = mount("sid-summary");
    act(() => transport.deliver("sid-summary", { type: "compacting", active: true, summary: "Primary request" }));
    expect(await screen.findByText("Primary request")).toBeInTheDocument();

    act(() => transport.deliver("sid-summary", { type: "compaction-summary", text: " and intent", replace: false }));
    expect(screen.getByText("Primary request and intent")).toBeInTheDocument();

    // A retried summariser starts its summary from nothing.
    act(() => transport.deliver("sid-summary", { type: "compaction-summary", text: "Retried", replace: true }));
    expect(screen.getByText("Retried")).toBeInTheDocument();

    const chip = screen.getByRole("button", { name: /Compacting the context/ });
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(chip);
    expect(screen.queryByText("Retried")).toBeNull();
    expect(chip).toHaveAttribute("aria-expanded", "false");

    act(() => transport.deliver("sid-summary", { type: "compacting", active: false }));
    expect(screen.queryByText("Compacting the context")).toBeNull();

    view.unmount();
    controlsHost.remove();
  });
});
