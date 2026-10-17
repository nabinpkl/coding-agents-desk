import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenMeter, formatTokens, modelFamily } from "@/features/activity-feed/TokenMeter";
import { newerUsage } from "@/features/activity-feed/usageFromEvents";

describe("TokenMeter", () => {
  it("renders a fill bar sized to the fraction of the known window", () => {
    render(
      <TokenMeter
        usage={{ current: 150_000, limit: 200_000, updatedAt: 1, model: "claude-opus-5" }}
      />,
    );

    const bar = screen.getByRole("progressbar", {
      name: "Context: 75% of 200,000 tokens",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("75%");
    expect(screen.getByRole("button", { name: "Context and limits" }).textContent).toContain("150k (75%)");
  });

  it("renders a bare count with no bar when no window is known", () => {
    render(<TokenMeter usage={{ current: 41_400, limit: null, updatedAt: 1 }} />);

    // A fraction of a guessed denominator reads as authoritative, so there is
    // deliberately nothing to divide by here.
    expect(screen.getByLabelText("Context: 41,400 tokens").textContent).toBe("41k");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders nothing before the transcript has published occupancy", () => {
    const { container } = render(<TokenMeter usage={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("clamps a reading that exceeds its own window", () => {
    render(<TokenMeter usage={{ current: 260_000, limit: 200_000, updatedAt: 1 }} />);

    // Codex publishes windows that change mid-session, so a reading briefly
    // measured against the smaller one must not overflow the track.
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("sets the session spend beside the count the way the TUI does", () => {
    render(
      <TokenMeter
        usage={{ current: 214_800, limit: 1_048_576, updatedAt: 1, cost: 1.691467206 }}
      />,
    );

    expect(screen.getByLabelText("Session cost $1.69").textContent).toBe("$1.69");
  });

  it("shows no dollar figure where no backend reported one", () => {
    render(
      <TokenMeter
        usage={{ current: 214_800, limit: 1_048_576, updatedAt: 1 }}
      />,
    );

    expect(screen.queryByLabelText(/Session cost/)).toBeNull();
  });
});

describe("formatTokens", () => {
  it("holds to at most four glyphs so the header does not reflow", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(41_400)).toBe("41k");
    expect(formatTokens(183_402)).toBe("183k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });

  it("rounds to the nearest thousand rather than truncating", () => {
    // Pins the direction: 41,500 reads as 42k, not 41k. The exact figure is one
    // hover away, so the compact form should be the closest one, not the lower.
    expect(formatTokens(41_500)).toBe("42k");
    expect(formatTokens(41_499)).toBe("41k");
  });
});

describe("newerUsage", () => {
  it("picks by timestamp so seed and live order does not matter", () => {
    const seed = { current: 1, limit: 200_000, updatedAt: 10 };
    const live = { current: 2, limit: 200_000, updatedAt: 20 };

    // A live chunk routinely lands before the seed fetch resolves.
    expect(newerUsage(seed, live)).toBe(live);
    expect(newerUsage(live, seed)).toBe(live);
    expect(newerUsage(null, seed)).toBe(seed);
    expect(newerUsage(seed, null)).toBe(seed);
    expect(newerUsage(null, null)).toBeNull();
  });
});

describe("cache countdown", () => {
  const HOUR = 60 * 60 * 1000;

  it("counts the minutes of prompt cache left", () => {
    // The step it counts down to is 20x: a cached context re-reads at 0.1x base
    // input and an expired one rewrites at 2.0x, so the minute this reaches zero
    // is the minute the next message gets ten times more expensive.
    render(
      <TokenMeter
        usage={{
          current: 500_000,
          limit: 1_000_000,
          updatedAt: Date.now() - 20.5 * 60_000,
          cacheTtlMs: HOUR,
        }}
      />,
    );

    expect(screen.getByLabelText("Prompt cache: 40 minutes left").textContent).toBe("40m");
  });

  it("holds at zero once expired rather than going negative", () => {
    render(
      <TokenMeter
        usage={{ current: 500_000, limit: null, updatedAt: Date.now() - 3 * HOUR, cacheTtlMs: HOUR }}
      />,
    );

    expect(screen.getByLabelText("Prompt cache: 0 minutes left").textContent).toBe("0m");
  });

  it("shows no countdown when the sidecar published no lifetime", () => {
    // Codex reports no cache breakdown, and a clock counting down to a deadline
    // we invented would read exactly like one counting down to a real deadline.
    render(<TokenMeter usage={{ current: 500_000, limit: 1_000_000, updatedAt: Date.now() }} />);

    expect(screen.queryByLabelText(/Prompt cache/)).toBeNull();
  });
});

describe("newerUsage cache lifetime", () => {
  it("carries the lifetime forward when the newer report names none", () => {
    const warm = { current: 1, limit: 200_000, updatedAt: 10, cacheTtlMs: 3_600_000 };
    // A request that was a pure cache hit wrote nothing, so it reports no
    // lifetime. That says the cache was used, not that it stopped having one.
    const pureHit = { current: 2, limit: 200_000, updatedAt: 20 };

    expect(newerUsage(warm, pureHit)).toEqual({ ...pureHit, cacheTtlMs: 3_600_000 });
    expect(newerUsage(pureHit, warm)).toEqual({ ...pureHit, cacheTtlMs: 3_600_000 });
  });

  it("takes the newer report's own lifetime when it names one", () => {
    const warm = { current: 1, limit: null, updatedAt: 10, cacheTtlMs: 3_600_000 };
    const short = { current: 2, limit: null, updatedAt: 20, cacheTtlMs: 300_000 };

    expect(newerUsage(warm, short)).toBe(short);
  });
});

describe("cost threshold", () => {
  it("warns on a context big enough that compacting pays, long before the window is full", () => {
    // 300k of a 1M window is 30% full and grey by every fraction rule, and it is also the range
    // where one more turn of work costs several times what compacting it would.
    render(
      <TokenMeter usage={{ current: 300_000, limit: 1_000_000, updatedAt: 1, model: "claude-opus-5" }} />,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-label")).toContain("Compacting now pays for itself");
    // The count carries it and the track does not: a 30% bar painted amber would be claiming the
    // window is nearly gone, which is a different and false thing.
    expect(screen.getByText(/300k/).className).toContain("text-amber-500");
    expect((bar.firstElementChild as HTMLElement).className).toContain("bg-muted-foreground/60");
  });

  it("leaves a context below the line alone", () => {
    render(<TokenMeter usage={{ current: 150_000, limit: 1_000_000, updatedAt: 1 }} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-label")).not.toContain("Compacting");
    expect((bar.firstElementChild as HTMLElement).className).toContain("bg-muted-foreground/60");
  });

  it("keeps running out louder than costing money", () => {
    // Both are true at 950k of 1M. The red is the one that cannot be put off, so it wins the
    // colour, and the tooltip still carries the cost.
    render(<TokenMeter usage={{ current: 950_000, limit: 1_000_000, updatedAt: 1 }} />);

    const bar = screen.getByRole("progressbar");
    expect((bar.firstElementChild as HTMLElement).className).toContain("bg-destructive");
    expect(bar.getAttribute("aria-label")).toContain("Compacting now pays for itself");
  });

  it("warns with no window at all, because the saving does not depend on one", () => {
    // Codex publishes windows that arrive late or not at all. What compacting saves is a property
    // of the context's size, so a bare count still has an answer.
    render(<TokenMeter usage={{ current: 300_000, limit: null, updatedAt: 1 }} />);

    const count = screen.getByLabelText(/^Context: 300,000 tokens/);
    expect(count.className).toContain("text-amber-500");
    expect(screen.getByLabelText(/Compacting now pays for itself/)).toBe(count);
  });
});

describe("model name", () => {
  it("names the model in the one word the footer has room for", () => {
    render(
      <TokenMeter usage={{ current: 150_000, limit: 1_000_000, updatedAt: 1, model: "claude-opus-5[1m]" }} />,
    );

    // The tier suffix is what makes this the 1M run rather than the 200k one, so it stays on the
    // title where the exact answer belongs. What the row shows is the word a reader is checking.
    expect(screen.getByLabelText("Model: claude-opus-5[1m]").textContent).toBe("opus");
  });

  it("leaves the model out where the composer's own selector already names it", () => {
    render(
      <TokenMeter
        usage={{ current: 150_000, limit: 1_000_000, updatedAt: 1, model: "claude-opus-5[1m]" }}
        showModel={false}
      />,
    );
    expect(screen.queryByLabelText("Model: claude-opus-5[1m]")).toBeNull();
  });

  it("says nothing for an id that is not shaped like one of Claude's", () => {
    // Codex names no model on an occupancy record, and a Claude line the harness stamped
    // `<synthetic>` names nothing real. A guessed word would read exactly like a measured one.
    render(<TokenMeter usage={{ current: 41_400, limit: null, updatedAt: 1, model: "<synthetic>" }} />);

    expect(screen.queryByLabelText(/^Model:/)).toBeNull();
  });
});

describe("modelFamily", () => {
  it("takes the family word off the id, whatever version follows it", () => {
    expect(modelFamily("claude-opus-5")).toBe("opus");
    expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    // The two ids one character apart that the sidecar's alias exists to keep separate share a
    // family, which is the whole point of showing the family here and the alias there.
    expect(modelFamily("claude-fable-5")).toBe("fable");
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
  });

  it("answers null rather than guessing at an id it cannot read", () => {
    expect(modelFamily(undefined)).toBeNull();
    expect(modelFamily("<synthetic>")).toBeNull();
    expect(modelFamily("gpt-5.6-sol")).toBeNull();
  });
});
