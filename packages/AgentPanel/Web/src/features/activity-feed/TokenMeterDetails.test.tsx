import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { QuotaReport } from "@agentdesk/agent-feed-wire";
import { TokenMeter } from "@/features/activity-feed/TokenMeter";

const USAGE = { current: 150_000, limit: 200_000, updatedAt: Date.now(), model: "claude-opus-5" };

function feedWith(quotas: QuotaReport["vendors"][number]["quotas"]) {
  return {
    fetchLimits: vi.fn(async (): Promise<QuotaReport> => ({
      vendors: [{ vendor: "claude", displayName: "Claude", quotas }],
    })),
  };
}

function quota(label: string, usedPercent: number, sampledAt = Date.now()) {
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

function meter() {
  return screen.getByRole("button", { name: "Context and limits" });
}

describe("the context readout's detail panel", () => {
  it("opens on hover and names every window the machine publishes", async () => {
    const feed = feedWith([quota("5-hour limit", 41), quota("Weekly limit", 63)]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());

    const panel = await screen.findByRole("dialog", { name: "Context and limits" });
    await waitFor(() => expect(panel.textContent).toContain("5-hour limit"));
    // Both windows, rather than whichever is fullest: either one can be the one that stops you,
    // and which that is changes during a day.
    expect(panel.textContent).toContain("Weekly limit");
    expect(screen.getByRole("progressbar", { name: "5-hour limit: 41% used" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Weekly limit: 63% used" })).toBeInTheDocument();
  });

  it("carries the figures the compact readout rounds away", async () => {
    const feed = feedWith([]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());

    const panel = await screen.findByRole("dialog");
    expect(panel.textContent).toContain("150,000 / 200,000 (75%)");
    expect(panel.textContent).toContain("claude-opus-5");
  });

  it("closes again when the pointer leaves, unless it was clicked open", async () => {
    const feed = feedWith([quota("5-hour limit", 41)]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());
    await screen.findByRole("dialog");
    fireEvent.pointerLeave(meter());
    expect(screen.queryByRole("dialog")).toBeNull();

    // A click pins it, which is what makes a number readable rather than glanceable: the pointer
    // has to travel to the panel to scroll or select, and hover alone would close it on the way.
    fireEvent.click(meter());
    fireEvent.pointerLeave(meter());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.click(meter());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why there is no meter rather than showing an empty one", async () => {
    // A sidecar that has not seen a response yet has no reading. Zero would read as "plenty left",
    // and a blank section as a bug.
    const feed = feedWith([]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());

    const panel = await screen.findByRole("dialog");
    await waitFor(() => expect(panel.textContent).toContain("No limit reading yet"));
    expect(screen.queryByRole("progressbar", { name: /used/ })).toBeNull();
  });

  it("reports a stale reading by its age rather than by a reset that has passed", async () => {
    const stale = quota("5-hour limit", 92, Date.now() - 45 * 60 * 60 * 1000);
    render(<TokenMeter usage={USAGE} feed={feedWith([stale])} />);

    fireEvent.pointerEnter(meter());

    const panel = await screen.findByRole("dialog");
    await waitFor(() => expect(panel.textContent).toContain("reading 1d old"));
    expect(panel.textContent).not.toContain("resets in");
  });

  it("asks the sidecar only once while a reader opens and closes it", async () => {
    const feed = feedWith([quota("5-hour limit", 41)]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());
    await screen.findByRole("dialog");
    fireEvent.pointerLeave(meter());
    fireEvent.pointerEnter(meter());
    await screen.findByRole("dialog");

    // The meters move only when a request comes back, and their own age is on screen either way.
    expect(feed.fetchLimits).toHaveBeenCalledTimes(1);
  });

  it("reports a read that failed, and does not retry it on every render", async () => {
    // Measured on a Canvas card against a sidecar that had not been restarted onto the route yet:
    // an open panel asked again on every render and took dozens of 404s in a few seconds.
    const feed = {
      fetchLimits: vi.fn(async () => {
        throw new Error("not found");
      }),
    };
    render(<TokenMeter usage={USAGE} feed={feed} />);

    fireEvent.pointerEnter(meter());
    const panel = await screen.findByRole("dialog");
    await waitFor(() => expect(panel.textContent).toContain("Limits unavailable: not found"));

    fireEvent.pointerLeave(meter());
    fireEvent.pointerEnter(meter());
    await screen.findByRole("dialog");
    expect(feed.fetchLimits).toHaveBeenCalledTimes(1);
  });

  it("stays closed until it is asked for, though the meters are already on screen", async () => {
    const feed = feedWith([quota("5-hour limit", 41)]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    // The chip is the readout now, so the meters ARE read at mount. What stays away is the panel.
    expect(await screen.findByText("5h: 41%")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the limit chips in the composer footer", () => {
  it("says the account's windows the way the CLI's status line does", async () => {
    const feed = feedWith([quota("5-hour limit", 25), quota("Weekly limit", 51)]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    // Both windows, shortest first, without anything being opened: either can be the one that
    // stops you, and which that is changes during a day.
    expect(await screen.findByText("5h: 25%")).toBeInTheDocument();
    expect(screen.getByText("7d: 51%")).toBeInTheDocument();
  });

  it("leaves the model-scoped weeklies to the popover", async () => {
    // Claude publishes seven_day_opus beside its account-wide seven_day, and both would draw as
    // "7d" here. Two chips of the same name at different numbers is a surface that looks broken.
    const scoped = { ...quota("Weekly limit (Opus)", 77), scope: "Opus" };
    render(<TokenMeter usage={USAGE} feed={feedWith([quota("Weekly limit", 51), scoped])} />);

    expect(await screen.findByText("7d: 51%")).toBeInTheDocument();
    expect(screen.queryByText("7d: 77%")).toBeNull();
  });

  it("shows nothing rather than a confident zero before the first reading", async () => {
    const feed = feedWith([]);
    render(<TokenMeter usage={USAGE} feed={feed} />);

    // Waited for rather than asserted straight away: the read settles after the first paint, and
    // the question here is what the chip shows once it HAS an answer and the answer is empty.
    await waitFor(() => expect(feed.fetchLimits).toHaveBeenCalled());
    expect(screen.queryByText(/^\d+[hd]: /)).toBeNull();
  });

  it("reads one meter for every card on the same machine", async () => {
    // The limits are an account-wide fact and a canvas draws them on every open card. One data
    // source per machine is what makes that one read instead of eight.
    const feed = feedWith([quota("5-hour limit", 25)]);
    render(
      <>
        <TokenMeter usage={USAGE} feed={feed} />
        <TokenMeter usage={USAGE} feed={feed} />
        <TokenMeter usage={USAGE} feed={feed} />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText("5h: 25%")).toHaveLength(3));
    expect(feed.fetchLimits).toHaveBeenCalledTimes(1);
  });

  it("shows only the session's own vendor, because both vendors meter five hours", async () => {
    const feed = {
      fetchLimits: vi.fn(async (): Promise<QuotaReport> => ({
        vendors: [
          { vendor: "codex", displayName: "Codex", quotas: [quota("5-hour limit", 88)] },
          { vendor: "claude", displayName: "Claude", quotas: [quota("5-hour limit", 25)] },
        ],
      })),
    };
    render(<TokenMeter usage={USAGE} feed={feed} vendor="claude" />);

    expect(await screen.findByText("5h: 25%")).toBeInTheDocument();
    expect(screen.queryByText("5h: 88%")).toBeNull();
  });
});
