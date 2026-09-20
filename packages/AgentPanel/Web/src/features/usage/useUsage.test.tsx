import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarConfig, UsageReport, UsageStreamMessage } from "@agentdesk/agent-feed-wire";
import { useUsage } from "@/features/usage/useUsage";

const config: SidecarConfig = {
  staleThresholdMs: 1,
  readyThresholdMs: 1,
  liveWindowMs: 1,
  watcherState: "live",
  sessionCount: 1,
  summaryEnabled: false,
  summaryModel: null,
  usageVendors: ["codex"],
  parkAvailable: false,
  supervisor: null,
};

function report(inputTokens: number): UsageReport {
  return {
    vendors: [{
      vendor: "codex",
      displayName: "Codex",
      installed: true,
      days: [{
        date: "2026-08-13",
        totals: { inputTokens, cachedInputTokens: 60, outputTokens: 5, reasoningTokens: 1, requests: 2 },
        byModel: [],
      }],
      quotas: [],
      coverage: { from: "2026-08-13", to: "2026-08-13", sessions: 1, unreadable: 0 },
      scannedAt: 1,
    }],
  };
}

function stream() {
  let deliver: ((message: UsageStreamMessage) => void) | null = null;
  let fail: ((reason: string) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribeUsage = vi.fn().mockImplementation((handlers) => {
    deliver = handlers.onMessage;
    fail = handlers.onError;
    return unsubscribe;
  });
  return {
    unsubscribe,
    subscribeUsage,
    send: (message: UsageStreamMessage) => act(() => deliver?.(message)),
    drop: (reason: string) => act(() => fail?.(reason)),
    feed: { fetchConfig: vi.fn().mockResolvedValue(config), subscribeUsage },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Lets the mount-time config read resolve.
 *
 * Every test needs it even when it does not assert on vendors: the read settles a promise, and a
 * state update outside `act` is a warning that would bury a real one.
 */
async function settleConfig(): Promise<void> {
  await act(async () => {});
}

describe("useUsage", () => {
  it("reads which vendors exist once, from the sidecar's config", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await waitFor(() => expect(result.current.vendors).toEqual(["codex"]));
    // Nothing swept yet: a report costs gigabytes of reading on a cold cache, and the panel
    // launching is not somebody asking what their week cost.
    expect(harness.subscribeUsage).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("offers nothing when the sidecar names no vendors", async () => {
    const feed = {
      fetchConfig: vi.fn().mockResolvedValue({ ...config, usageVendors: [] }),
      subscribeUsage: vi.fn(),
    };
    const { result } = renderHook(() => useUsage(feed));
    await waitFor(() => expect(feed.fetchConfig).toHaveBeenCalled());
    expect(result.current.vendors).toEqual([]);
  });

  it("offers nothing when the sidecar cannot be reached at all", async () => {
    const feed = {
      fetchConfig: vi.fn().mockRejectedValue(new Error("down")),
      subscribeUsage: vi.fn(),
    };
    const { result } = renderHook(() => useUsage(feed));
    await waitFor(() => expect(feed.fetchConfig).toHaveBeenCalled());
    expect(result.current.vendors).toEqual([]);
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("paints the cache first and corrects it when the sweep lands", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    expect(result.current.state).toEqual({ kind: "loading" });

    harness.send({ type: "report", report: report(100) });
    expect(result.current.state).toMatchObject({ kind: "ready", settled: false });

    harness.send({ type: "report", report: report(150) });
    harness.send({ type: "settled" });
    expect(result.current.state).toMatchObject({ kind: "ready", settled: true });
    expect(
      result.current.state.kind === "ready" && result.current.state.report.vendors[0]!.days[0]!.totals.inputTokens,
    ).toBe(150);
  });

  it("closes the stream when the sweep settles, because it is finite and expensive", async () => {
    // An `EventSource` reopens a stream the server closed, and reopening this one means another
    // sweep of every session file on the machine.
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    harness.send({ type: "report", report: report(100) });
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    harness.send({ type: "settled" });
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not open a second stream while one is running", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    act(() => result.current.load());
    expect(harness.subscribeUsage).toHaveBeenCalledTimes(1);
  });

  it("re-sweeps on a later open, keeping what is already on screen", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    harness.send({ type: "report", report: report(100) });
    harness.send({ type: "settled" });

    act(() => result.current.load());
    expect(harness.subscribeUsage).toHaveBeenCalledTimes(2);
    // Still showing the previous numbers rather than a skeleton: they were real when they
    // arrived, and the sweep behind them is incremental.
    expect(result.current.state).toMatchObject({ kind: "ready", settled: false });
  });

  it("shows a coded failure from the sweep", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    harness.send({
      type: "error",
      error: { code: "usage-scan-failed", message: "disk went away", retryable: true },
    });
    expect(result.current.state).toEqual({ kind: "error", message: "disk went away" });
    expect(harness.unsubscribe).toHaveBeenCalled();
  });

  it("keeps a delivered report when the stream drops before settling", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    harness.send({ type: "report", report: report(100) });
    harness.drop("connection lost");
    // The numbers were real when they arrived. What changes is that they stop claiming a sweep
    // is still running behind them.
    expect(result.current.state).toMatchObject({ kind: "ready", settled: true });
  });

  it("reports a drop with nothing on screen as the error it is", async () => {
    const harness = stream();
    const { result } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    harness.drop("connection lost");
    expect(result.current.state).toEqual({ kind: "error", message: "connection lost" });
  });

  it("closes the stream when the panel goes away", async () => {
    const harness = stream();
    const { result, unmount } = renderHook(() => useUsage(harness.feed));
    await settleConfig();
    act(() => result.current.load());
    unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
