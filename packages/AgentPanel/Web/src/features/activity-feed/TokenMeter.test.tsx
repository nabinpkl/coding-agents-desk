import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenMeter, formatTokens } from "./TokenMeter";
import { newerUsage } from "./useSessionEventsStream";

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
    expect(screen.getByTitle(/150,000 \/ 200,000 tokens/).textContent).toContain("150k");
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
