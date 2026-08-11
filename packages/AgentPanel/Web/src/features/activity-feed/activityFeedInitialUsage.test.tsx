import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import { SidecarDataSource } from "./data-source/SidecarDataSource";
import { FakeHttpTransport } from "./transport/FakeHttpTransport";
import { ActivityFeed } from "./ActivityFeed";
import { TokenMeter } from "./TokenMeter";
import type { TokenUsage } from "./useSessionEventsStream";

// Same jsdom-unsafe deps the app tests stub.
vi.mock("./markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-view">{content}</div>
  ),
}));
vi.mock("./DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

// The feed's stick-to-bottom machinery observes the scroller; jsdom has none.
class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

/**
 * Full-chain regression coverage for the initial meter value: the real
 * ActivityFeed + real useSessionEventsStream + real SidecarDataSource driven
 * by a scripted timeline stream. Covers what the app-level tests cannot, because they mock
 * ActivityFeed: the snapshot's occupancy must reach the composer band's meter
 * before any live upsert exists, and when the snapshot carries no structured
 * occupancy the transcript's own last reading must initialize it.
 */
describe("initial usage, full feed chain", () => {
  it("mirrors the snapshot's occupancy up through ActivityFeed.onUsage", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    let seen: TokenUsage | null = null;

    function Harness() {
      const [usage, setUsage] = useState<TokenUsage | null>(null);
      seen = usage;
      return (
        <DataSourceProvider source={source}>
          <ActivityFeed
            source="claude"
            sessionId="sid-1"
            mode="nice"
            onToggleMode={() => {}}
            showCacheHits={false}
            onToggleCacheHits={() => {}}
            controlsHost={null}
            onUsage={setUsage}
          />
          <TokenMeter usage={usage} />
        </DataSourceProvider>
      );
    }

    render(<Harness />);

    act(() => {
      transport.deliver("sid-1", {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 1468,
          mode: "nice",
          events: [],
          windowStart: 1368,
          total: 1468,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
          usage: { current: 125_219, limit: 200_000, updatedAt: 1786093420166, model: "claude-opus-5" },
        },
      });
    });

    await waitFor(() => expect(seen?.current).toBe(125_219));
    expect(
      await screen.findByRole("progressbar", { name: "Context: 63% of 200,000 tokens" }),
    ).toBeInTheDocument();
  });

  it("initializes from the transcript's last reading when the snapshot carries none", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    let seen: TokenUsage | null = null;

    function Harness() {
      const [usage, setUsage] = useState<TokenUsage | null>(null);
      seen = usage;
      return (
        <DataSourceProvider source={source}>
          <ActivityFeed
            source="claude"
            sessionId="sid-2"
            mode="nice"
            onToggleMode={() => {}}
            showCacheHits={false}
            onToggleCacheHits={() => {}}
            controlsHost={null}
            onUsage={setUsage}
          />
          <TokenMeter usage={usage} />
        </DataSourceProvider>
      );
    }

    render(<Harness />);

    act(() => {
      transport.deliver("sid-2", {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 2,
          mode: "nice",
          events: [
            {
              id: "claude:line:4",
              index: 0,
              otherModeIndex: 0,
              revision: 0,
              phase: "complete",
              ts: 1000,
              type: "user",
              blocks: [{ kind: "text", text: "prompt" }],
            },
            {
              id: "claude:line:11",
              index: 1,
              otherModeIndex: 1,
              revision: 0,
              phase: "complete",
              ts: 2000,
              type: "assistant",
              blocks: [
                { kind: "text", text: "answer" },
                { kind: "metadata", label: "Token Usage", text: "71,411 tokens" },
              ],
            },
          ],
          windowStart: 0,
          total: 2,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
          // No `usage` at all, which is the case this test exists for: the sidecar resolved none,
          // so the transcript's own last reading has to initialize the meter.
        },
      });
    });

    await waitFor(() => expect(seen?.current).toBe(71_411));
    // The transcript reading has no window, so the meter shows a bare count
    // without a bar rather than a fraction of a guessed denominator.
    expect(await screen.findByText("71k")).toBeInTheDocument();
  });
});
