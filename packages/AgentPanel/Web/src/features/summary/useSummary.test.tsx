import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { SidecarConfig, SummaryResult, SummaryStreamMessage } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "../activity-feed/data-source/SidecarDataSource";
import { useSummary } from "./useSummary";

const enabled: SidecarConfig = {
  staleThresholdMs: 1, readyThresholdMs: 1, liveWindowMs: 1,
  watcherState: "live", sessionCount: 1,
  summaryEnabled: true, summaryModel: "opencode-go/deepseek-v4-flash",
  usageVendors: ["codex"],
};

function digest(headline: string): SummaryResult {
  return {
    phase: "final", generatedAt: 1, model: "m", headline, narrative: "n",
    filesTouched: [], risks: [], reasoning: [],
    coverage: { fromEventIndex: 0, toEventIndex: 1, mode: "nice", truncated: false },
    runState: "idle",
  };
}

/**
 * A summarizer stream the test drives by hand, and can ask whether the hook closed.
 *
 * Closing matters enough to be observable here: this stream is finite and expensive, and a
 * subscription left open on an ended one is a subscription `EventSource` reopens, which buys
 * another digest.
 */
function fakeStream() {
  let deliver: ((message: SummaryStreamMessage) => void) | null = null;
  let fail: ((reason: string) => void) | null = null;
  let open = 0;
  const summarizeTurn = vi.fn().mockImplementation((_session, handlers) => {
    deliver = handlers.onMessage;
    fail = handlers.onError;
    open += 1;
    return () => { open -= 1; };
  });
  return {
    feed: { fetchConfig: vi.fn().mockResolvedValue(enabled), summarizeTurn },
    send: (message: SummaryStreamMessage) => act(() => deliver!(message)),
    fail: (reason: string) => act(() => fail!(reason)),
    openStreams: () => open,
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
      <span data-testid="reasoning">
        {summary.state.kind === "pending" ? summary.state.reasoning.length : "-"}
      </span>
      <span data-testid="thought">
        {summary.state.kind === "pending" ? summary.state.thought : "-"}
      </span>
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

  it("accumulates reasoning as it arrives, then lets the finished block replace it", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(screen.getByTestId("kind").textContent).toBe("pending");

    await stream.send({ type: "thinking-delta", text: "Read " });
    await stream.send({ type: "thinking-delta", text: "the runtime." });
    expect(screen.getByTestId("thought").textContent).toBe("Read the runtime.");

    await stream.send({ type: "reasoning", text: "Read the runtime." });
    // One thought, not two: the partial is cleared by the block that completes it.
    expect(screen.getByTestId("thought").textContent).toBe("");
    expect(screen.getByTestId("reasoning").textContent).toBe("1");
  });

  it("collects each finished block as it lands", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });

    await stream.send({ type: "reasoning", text: "first" });
    await stream.send({ type: "reasoning", text: "second" });

    expect(screen.getByTestId("reasoning").textContent).toBe("2");
    expect(screen.getByTestId("thought").textContent).toBe("");
  });

  it("goes ready on the result, and closes the stream behind it", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(stream.openStreams()).toBe(1);

    await stream.send({ type: "result", result: digest("done") });

    expect(screen.getByTestId("kind").textContent).toBe("ready");
    expect(screen.getByTestId("headline").textContent).toBe("done");
    // Finite and expensive: an EventSource left on an ended stream reopens it, and reopening
    // this one starts another digest.
    expect(stream.openStreams()).toBe(0);
  });

  it("surfaces an error message from the stream and closes it", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });

    await stream.send({
      type: "error",
      error: { code: "summary-failed", message: "model refused", retryable: true },
    });

    expect(screen.getByTestId("kind").textContent).toBe("error");
    expect(screen.getByTestId("message").textContent).toBe("model refused");
    expect(stream.openStreams()).toBe(0);
  });

  it("reports a stream that never opened rather than spinning", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });

    await stream.fail("sidecar answered 503");

    expect(screen.getByTestId("kind").textContent).toBe("error");
    expect(screen.getByTestId("message").textContent).toBe("sidecar answered 503");
    expect(stream.openStreams()).toBe(0);
  });

  it("does not open a second stream while one is running", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    act(() => { screen.getByText("go").click(); });
    expect(stream.feed.summarizeTurn).toHaveBeenCalledTimes(1);
  });

  it("clears the digest when the viewer switches threads", async () => {
    const stream = fakeStream();
    const { rerender } = render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    await stream.send({ type: "result", result: digest("about s1") });
    expect(screen.getByTestId("headline").textContent).toBe("about s1");

    rerender(<Probe feed={stream.feed} session={S2} />);
    // The one failure worth designing against: one thread's digest under another thread's title.
    expect(screen.getByTestId("kind").textContent).toBe("idle");
  });

  it("abandons a run in progress when the viewer moves on", async () => {
    const stream = fakeStream();
    const { rerender } = render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(stream.openStreams()).toBe(1);

    rerender(<Probe feed={stream.feed} session={S2} />);

    // The run itself continues on the sidecar and is joinable; only this reader goes, which is
    // what stops a late answer from landing under the wrong thread's title.
    expect(stream.openStreams()).toBe(0);
    expect(screen.getByTestId("kind").textContent).toBe("idle");
  });

  it("dismisses, closing the stream if one is still open", async () => {
    const stream = fakeStream();
    render(<Probe feed={stream.feed} session={S1} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    act(() => { screen.getByText("clear").click(); });
    expect(screen.getByTestId("kind").textContent).toBe("idle");
    expect(stream.openStreams()).toBe(0);
  });

  it("does nothing with no thread selected", async () => {
    const feed = { fetchConfig: vi.fn().mockResolvedValue(enabled), summarizeTurn: vi.fn() };
    render(<Probe feed={feed} session={null} />);
    await flush();
    act(() => { screen.getByText("go").click(); });
    expect(feed.summarizeTurn).not.toHaveBeenCalled();
  });
});
