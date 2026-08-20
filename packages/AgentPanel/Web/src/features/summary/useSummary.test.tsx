import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { SidecarConfig, SummaryResult } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "../activity-feed/data-source/SidecarDataSource";
import { useSummary } from "./useSummary";

const enabled: SidecarConfig = {
  staleThresholdMs: 1, readyThresholdMs: 1, liveWindowMs: 1,
  watcherState: "live", sessionCount: 1,
  summaryEnabled: true, summaryModel: "opencode-go/deepseek-v4-flash",
};

function digest(headline: string): SummaryResult {
  return {
    phase: "final", generatedAt: 1, model: "m", headline, narrative: "n",
    filesTouched: [], risks: [], steps: [],
    coverage: { fromEventIndex: 0, toEventIndex: 1, mode: "nice", truncated: false },
    runState: "idle",
  };
}

/** Renders the hook's state as text, which is all these tests need to read. */
function Probe({ feed, session }: { feed: Parameters<typeof useSummary>[0]; session: SessionAddress | null }) {
  const summary = useSummary(feed, session);
  return (
    <div>
      <span data-testid="available">{String(summary.available)}</span>
      <span data-testid="model">{summary.model ?? "-"}</span>
      <span data-testid="kind">{summary.state.kind}</span>
      <span data-testid="headline">
        {summary.state.kind === "ready" ? summary.state.result.headline : "-"}
      </span>
      <span data-testid="message">
        {summary.state.kind === "error" ? summary.state.message : "-"}
      </span>
      <button type="button" onClick={summary.summarize}>go</button>
      <button type="button" onClick={summary.dismiss}>clear</button>
    </div>
  );
}

const S1: SessionAddress = { source: "claude", sessionId: "s1" };
const S2: SessionAddress = { source: "claude", sessionId: "s2" };

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe("useSummary", () => {
  it("stays unavailable until the sidecar says a model is configured", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue({ ...enabled, summaryEnabled: false, summaryModel: null }),
      summarizeTurn: vi.fn(),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("available").textContent).toBe("false");
  });

  it("reports the configured model so the band can name it", async () => {
    const feed = { fetchConfig: vi.fn().mockResolvedValue(enabled), summarizeTurn: vi.fn() };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("available").textContent).toBe("true");
    expect(screen.getByTestId("model").textContent).toBe("opencode-go/deepseek-v4-flash");
  });

  it("a sidecar that cannot answer /api/config leaves the button hidden, not broken", async () => {
    const feed = { fetchConfig: vi.fn().mockRejectedValue(new Error("down")), summarizeTurn: vi.fn() };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("available").textContent).toBe("false");
    expect(screen.getByTestId("kind").textContent).toBe("idle");
  });

  it("goes pending, then ready", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue(enabled),
      summarizeTurn: vi.fn().mockResolvedValue(digest("done")),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(screen.getByTestId("kind").textContent).toBe("pending");
    await flush();
    expect(screen.getByTestId("kind").textContent).toBe("ready");
    expect(screen.getByTestId("headline").textContent).toBe("done");
  });

  it("surfaces a failed run as an error state", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue(enabled),
      summarizeTurn: vi.fn().mockRejectedValue(new Error("model refused")),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    await flush();
    expect(screen.getByTestId("kind").textContent).toBe("error");
    expect(screen.getByTestId("message").textContent).toBe("model refused");
  });

  it("clears the digest when the viewer switches threads", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue(enabled),
      summarizeTurn: vi.fn().mockResolvedValue(digest("about s1")),
    };
    const { rerender } = render(<Probe feed={feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    await flush();
    expect(screen.getByTestId("headline").textContent).toBe("about s1");

    rerender(<Probe feed={feed} session={S2} />);
    // The one failure worth designing against: one thread's digest under another thread's title.
    expect(screen.getByTestId("kind").textContent).toBe("idle");
  });

  it("drops an answer that lands after the viewer moved on", async () => {
    let settle!: (result: SummaryResult) => void;
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue(enabled),
      summarizeTurn: vi.fn().mockImplementation(
        () => new Promise<SummaryResult>((resolve) => { settle = resolve; }),
      ),
    };
    const { rerender } = render(<Probe feed={feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    rerender(<Probe feed={feed} session={S2} />);
    await act(async () => { settle(digest("late answer for s1")); await Promise.resolve(); });
    expect(screen.getByTestId("kind").textContent).toBe("idle");
    expect(screen.getByTestId("headline").textContent).toBe("-");
  });

  it("dismisses", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue(enabled),
      summarizeTurn: vi.fn().mockResolvedValue(digest("done")),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    await flush();
    act(() => { screen.getByText("clear").click(); });
    expect(screen.getByTestId("kind").textContent).toBe("idle");
  });

  it("does nothing with no thread selected", async () => {
    const feed = { fetchConfig: vi.fn().mockResolvedValue(enabled), summarizeTurn: vi.fn() };
    render(<Probe feed={feed} session={null} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(feed.summarizeTurn).not.toHaveBeenCalled();
  });
});
