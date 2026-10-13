import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LimitsStreamMessage, UsageQuota } from "@agentdesk/agent-feed-wire";
import { TokenMeter } from "@/features/activity-feed/TokenMeter";

const USAGE = { current: 150_000, limit: 200_000, updatedAt: Date.now(), model: "claude-opus-5" };

function quota(label: string, usedPercent: number, sampledAt = Date.now()): UsageQuota {
  return {
    label,
    usedPercent,
    windowMinutes: label.startsWith("5") ? 300 : 10_080,
    resetsAt: Date.now() + 2 * 60 * 60 * 1000,
    scope: null,
    planType: null,
    sampledAt,
  };
}

/**
 * A sidecar that pushes, the way the real one does.
 *
 * Nothing is delivered until a test says so, which is the honest shape: the meters arrive when a
 * response crosses the proxy, not when the panel asks.
 */
function limits() {
  let deliver: ((message: LimitsStreamMessage) => void) | null = null;
  let fail: ((reason: string) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribeLimits = vi.fn((handlers: {
    onMessage: (message: LimitsStreamMessage) => void;
    onError: (reason: string) => void;
  }) => {
    deliver = handlers.onMessage;
    fail = handlers.onError;
    return unsubscribe;
  });
  return {
    feed: { subscribeLimits },
    subscribeLimits,
    unsubscribe,
    push: (quotas: UsageQuota[]) =>
      act(() => deliver?.({
        type: "report",
        report: { vendors: [{ vendor: "claude", displayName: "Claude", quotas }] },
      })),
    pushVendors: (vendors: { vendor: "claude" | "codex"; displayName: string; quotas: UsageQuota[] }[]) =>
      act(() => deliver?.({ type: "report", report: { vendors } })),
    pushError: (message: string) =>
      act(() => deliver?.({
        type: "error",
        error: { code: "limits-read-failed", message, retryable: true },
      })),
    drop: (reason: string) => act(() => fail?.(reason)),
  };
}

function meter() {
  return screen.getByRole("button", { name: "Context and limits" });
}

describe("the context readout's detail panel", () => {
  it("opens on hover and names every window the machine publishes", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("5-hour limit", 41), quota("Weekly limit", 63)]);

    fireEvent.pointerEnter(meter());

    const panel = screen.getByRole("dialog", { name: "Context and limits" });
    expect(panel.textContent).toContain("5-hour limit");
    // Both windows, rather than whichever is fullest: either one can be the one that stops you,
    // and which that is changes during a day.
    expect(panel.textContent).toContain("Weekly limit");
    expect(screen.getByRole("progressbar", { name: "5-hour limit: 41% used" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Weekly limit: 63% used" })).toBeInTheDocument();
  });

  it("carries the figures the compact readout rounds away", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([]);

    fireEvent.pointerEnter(meter());

    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toContain("150,000 / 200,000 (75%)");
    expect(panel.textContent).toContain("claude-opus-5");
  });

  it("closes again when the pointer leaves, unless it was clicked open", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("5-hour limit", 41)]);

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(meter());
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.pointerLeave(meter());
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole("dialog")).toBeNull();

      // A click pins it, so it stays until dismissed whatever the pointer does.
      fireEvent.click(meter());
      fireEvent.pointerLeave(meter());
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.click(meter());
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open while the pointer crosses from the readout into the panel", () => {
    vi.useFakeTimers();
    try {
      render(<TokenMeter usage={USAGE} />);
      fireEvent.pointerEnter(meter());
      fireEvent.pointerLeave(meter());
      // The gap between the two is a moment outside both.
      act(() => vi.advanceTimersByTime(60));
      const panel = screen.getByRole("dialog");
      fireEvent.pointerEnter(panel);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.pointerLeave(panel);
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on a tap rather than on the enter a touch fires around it", () => {
    render(<TokenMeter usage={USAGE} />);
    fireEvent.pointerEnter(meter(), { pointerType: "touch" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(meter());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // A second tap shuts it, as does a tap anywhere else.
    fireEvent.click(meter());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(meter());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a second click even with the mouse still over it", () => {
    render(<TokenMeter usage={USAGE} />);
    fireEvent.pointerEnter(meter());
    fireEvent.click(meter());
    fireEvent.click(meter());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts every chip on the row behind one trigger, with no tooltip to cover the panel", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("Weekly limit", 13)]);
    expect(meter().textContent).toContain("7d: 13%");
    expect(meter().querySelector("[title]")).toBeNull();
  });

  it("says why there is no meter rather than showing an empty one", () => {
    // A sidecar that has not seen a response yet has no reading. Zero would read as "plenty left",
    // and a blank section as a bug.
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([]);

    fireEvent.pointerEnter(meter());

    expect(screen.getByRole("dialog").textContent).toContain("No limit reading yet");
    expect(screen.queryByRole("progressbar", { name: /used/ })).toBeNull();
  });

  it("reports a stale reading by its age rather than by a reset that has passed", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("5-hour limit", 92, Date.now() - 45 * 60 * 60 * 1000)]);

    fireEvent.pointerEnter(meter());

    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toContain("reading 1d old");
    expect(panel.textContent).not.toContain("resets in");
  });

  it("names a stream that failed instead of showing meters that are not there", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.drop("connection lost");

    fireEvent.pointerEnter(meter());

    expect(screen.getByRole("dialog").textContent).toContain("Limits unavailable: connection lost");
  });

  it("names a read the sidecar itself could not make", () => {
    // The route answers this rather than closing: reading the CLI's config can fail while the
    // stream is perfectly healthy, and the two are different things to tell a reader.
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.pushError("EACCES");

    fireEvent.pointerEnter(meter());

    expect(screen.getByRole("dialog").textContent).toContain("Limits unavailable: EACCES");
  });
});

describe("the limit chips in the composer footer", () => {
  it("says the account's windows the way the CLI's status line does", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("5-hour limit", 25), quota("Weekly limit", 51)]);

    // Both windows, shortest first, without anything being opened.
    expect(screen.getByText("5h: 25%")).toBeInTheDocument();
    expect(screen.getByText("7d: 51%")).toBeInTheDocument();
  });

  it("moves when a response crosses the proxy, without being asked again", () => {
    // The reason this is a stream. The sidecar is told the moment a request comes back, and the
    // chip follows it rather than waiting out a timer.
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("5-hour limit", 25)]);
    expect(screen.getByText("5h: 25%")).toBeInTheDocument();

    sidecar.push([quota("5-hour limit", 26)]);

    expect(screen.getByText("5h: 26%")).toBeInTheDocument();
    expect(sidecar.subscribeLimits).toHaveBeenCalledTimes(1);
  });

  it("leaves the model-scoped weeklies to the popover", () => {
    // Claude publishes seven_day_opus beside its account-wide seven_day, and both would draw as
    // "7d" here. Two chips of the same name at different numbers is a surface that looks broken.
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([quota("Weekly limit", 51), { ...quota("Weekly limit (Opus)", 77), scope: "Opus" }]);

    expect(screen.getByText("7d: 51%")).toBeInTheDocument();
    expect(screen.queryByText("7d: 77%")).toBeNull();
  });

  it("still draws a window whose reading carries no scope field at all", () => {
    // What a sidecar that has not restarted onto the new field sends. Read as a scope, `undefined`
    // would hide every chip, so the feature would look broken rather than merely older.
    const sidecar = limits();
    const { scope: _scope, ...unscoped } = quota("5-hour limit", 40);
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    sidecar.push([unscoped as UsageQuota]);

    expect(screen.getByText("5h: 40%")).toBeInTheDocument();
  });

  it("shows nothing rather than a confident zero before the first reading", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);

    // Subscribed, but nothing has crossed the proxy yet.
    expect(sidecar.subscribeLimits).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^\d+[hd]: /)).toBeNull();
  });

  it("opens one stream for every card on the same machine", () => {
    // The limits are an account-wide fact and a canvas draws them on every open card. One data
    // source per machine is what makes that one subscription instead of eight, which matters more
    // for a stream than for a read: the relay admits a bounded number of them.
    const sidecar = limits();
    render(
      <>
        <TokenMeter usage={USAGE} feed={sidecar.feed} />
        <TokenMeter usage={USAGE} feed={sidecar.feed} />
        <TokenMeter usage={USAGE} feed={sidecar.feed} />
      </>,
    );
    sidecar.push([quota("5-hour limit", 25)]);

    expect(screen.getAllByText("5h: 25%")).toHaveLength(3);
    expect(sidecar.subscribeLimits).toHaveBeenCalledTimes(1);
  });

  it("drops the stream when the last card goes away", () => {
    const sidecar = limits();
    const first = render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);
    const second = render(<TokenMeter usage={USAGE} feed={sidecar.feed} />);

    first.unmount();
    expect(sidecar.unsubscribe).not.toHaveBeenCalled();

    second.unmount();
    expect(sidecar.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows only the session's own vendor, because both vendors meter five hours", () => {
    const sidecar = limits();
    render(<TokenMeter usage={USAGE} feed={sidecar.feed} vendor="claude" />);
    sidecar.pushVendors([
      { vendor: "codex", displayName: "Codex", quotas: [quota("5-hour limit", 88)] },
      { vendor: "claude", displayName: "Claude", quotas: [quota("5-hour limit", 25)] },
    ]);

    expect(screen.getByText("5h: 25%")).toBeInTheDocument();
    expect(screen.queryByText("5h: 88%")).toBeNull();
  });
});

describe("the panel's Compact button", () => {
  const compactButton = () => screen.getByRole("button", { name: "Compact this session's context" });

  it("sends /compact and closes once it went", async () => {
    const run = vi.fn(async () => true);
    render(<TokenMeter usage={USAGE} compact={{ run, blocked: null }} />);
    fireEvent.click(meter());
    await act(async () => fireEvent.click(compactButton()));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why it cannot, rather than offering a press that does nothing", () => {
    const run = vi.fn(async () => true);
    render(<TokenMeter usage={USAGE} compact={{ run, blocked: "Send or clear the draft in the composer first." }} />);
    fireEvent.click(meter());
    expect(compactButton()).toBeDisabled();
    expect(screen.getByRole("dialog").textContent).toContain("Send or clear the draft in the composer first.");
  });

  it("stays open and says so when the composer refused it", async () => {
    render(<TokenMeter usage={USAGE} compact={{ run: async () => { throw new Error("pane gone"); }, blocked: null }} />);
    fireEvent.click(meter());
    await act(async () => fireEvent.click(compactButton()));
    expect(screen.getByRole("dialog").textContent).toContain("/compact did not go through: pane gone");
    expect(compactButton()).not.toBeDisabled();
  });

  it("reaches for what the send needs as soon as it is shown", () => {
    const prepare = vi.fn();
    render(<TokenMeter usage={USAGE} compact={{ run: async () => false, blocked: "Reaching this session's terminal\u2026", prepare }} />);
    expect(prepare).not.toHaveBeenCalled();
    fireEvent.click(meter());
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("is absent where the composer has no way to send one", () => {
    render(<TokenMeter usage={USAGE} />);
    fireEvent.click(meter());
    expect(screen.queryByRole("button", { name: "Compact this session's context" })).toBeNull();
  });
});
