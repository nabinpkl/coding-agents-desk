import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import { BridgeDataSource } from "./data-source/BridgeDataSource";
import { FakeHostBridge } from "./data-source/HostBridge";
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
 * ActivityFeed + real useSessionEventsStream + real BridgeDataSource driven
 * by a host replay. Covers what the app-level tests cannot, because they mock
 * ActivityFeed: the snapshot's occupancy must reach the composer band's meter
 * before any live upsert exists, and when the snapshot carries no structured
 * occupancy the transcript's own last reading must initialize it.
 */
describe("initial usage, full feed chain", () => {
  it("mirrors the snapshot's occupancy up through ActivityFeed.onUsage", async () => {
    const host = new FakeHostBridge();
    const source = new BridgeDataSource(host);
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
            controlsHost={null}
            onUsage={setUsage}
          />
          <TokenMeter usage={usage} />
        </DataSourceProvider>
      );
    }

    render(<Harness />);

    act(() => {
      host.deliver({
        t: "agent-thread-chunk",
        src: "claude",
        sid: "sid-1",
        ev: [],
        ws: 1368,
        tot: 1468,
        lv: false,
        u: { cur: 125_219, lim: 200_000, ua: 1786093420166, mdl: "claude-opus-5" },
        md: "nice",
        k: "snapshot",
        seq: 1468,
        rs: "idle",
        qs: 0,
        qf: 0,
      });
    });

    await waitFor(() => expect(seen?.current).toBe(125_219));
    expect(
      await screen.findByRole("progressbar", { name: "Context: 63% of 200,000 tokens" }),
    ).toBeInTheDocument();
  });

  it("initializes from the transcript's last reading when the snapshot carries none", async () => {
    const host = new FakeHostBridge();
    const source = new BridgeDataSource(host);
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
            controlsHost={null}
            onUsage={setUsage}
          />
          <TokenMeter usage={usage} />
        </DataSourceProvider>
      );
    }

    render(<Harness />);

    act(() => {
      host.deliver({
        t: "agent-thread-chunk",
        src: "claude",
        sid: "sid-2",
        ev: [
          {
            id: "claude:line:4",
            i: 0,
            xi: 0,
            rev: 0,
            ph: "complete",
            ts: 1000,
            tp: "user",
            b: [{ k: "text", tx: "prompt" }],
          },
          {
            id: "claude:line:11",
            i: 1,
            xi: 1,
            rev: 0,
            ph: "complete",
            ts: 2000,
            tp: "assistant",
            b: [
              { k: "text", tx: "answer" },
              { k: "metadata", lb: "Token Usage", tx: "71,411 tokens" },
            ],
          },
        ],
        ws: 0,
        tot: 2,
        lv: false,
        md: "nice",
        k: "snapshot",
        seq: 2,
        rs: "idle",
        qs: 0,
        qf: 0,
      });
    });

    await waitFor(() => expect(seen?.current).toBe(71_411));
    // The transcript reading has no window, so the meter shows a bare count
    // without a bar rather than a fraction of a guessed denominator.
    expect(await screen.findByText("71k")).toBeInTheDocument();
  });
});
