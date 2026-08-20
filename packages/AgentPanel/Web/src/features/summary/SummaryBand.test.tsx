import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SummaryResult } from "@agentdesk/agent-feed-wire";
import { SummaryBand } from "./SummaryBand";
import { SummaryControl } from "./SummaryControl";

function digest(overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    phase: "final",
    generatedAt: 1_750_000_000_000,
    model: "opencode-go/deepseek-v4-flash",
    headline: "Narrowed the summarizer to read-only tools",
    narrative: "It restricted the tool set and added a test.",
    filesTouched: [{ path: "src/summary/summaryRuntime.ts", status: "M", added: 12, removed: 3 }],
    risks: ["No test covers the budget abort path."],
    steps: [
      { kind: "thinking", text: "The turn names summaryRuntime.ts, so read that first." },
      { kind: "tool", name: "read", target: "src/summary/summaryRuntime.ts", failed: false },
    ],
    coverage: { fromEventIndex: 40, toEventIndex: 47, mode: "nice", truncated: false },
    runState: "idle",
    ...overrides,
  };
}

describe("the summary band", () => {
  it("renders nothing until something has been asked for", () => {
    const { container } = render(
      <SummaryBand state={{ kind: "idle" }} model={null} onDismiss={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces progress while the second model reads the turn", () => {
    render(
      <SummaryBand
        state={{ kind: "pending", steps: [], thought: "" }}
        model={null}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/Reading the turn/)).toBeTruthy();
  });

  it("shows the run as it happens, open, with no disclosure to find", () => {
    render(
      <SummaryBand
        state={{
          kind: "pending",
          steps: [{ kind: "tool", name: "read", target: "src/a.ts", failed: false }],
          thought: "Now check whether the test asserts it",
        }}
        model={null}
        onDismiss={() => {}}
      />,
    );
    // Nothing to click: a viewer is looking at this precisely because the answer is not here.
    expect(screen.queryByText(/how it read the turn/)).toBeNull();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("Now check whether the test asserts it")).toBeTruthy();
  });

  it("can be dismissed mid-run, not only once the digest lands", () => {
    const onDismiss = vi.fn();
    render(
      <SummaryBand
        state={{ kind: "pending", steps: [], thought: "" }}
        model={null}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows the digest, its files and its risks", () => {
    render(
      <SummaryBand state={{ kind: "ready", result: digest() }} model="opencode-go/deepseek-v4-flash" onDismiss={() => {}} />,
    );
    expect(screen.getByText("Narrowed the summarizer to read-only tools")).toBeTruthy();
    expect(screen.getByText("It restricted the tool set and added a test.")).toBeTruthy();
    expect(screen.getByText("src/summary/summaryRuntime.ts")).toBeTruthy();
    expect(screen.getByText("No test covers the budget abort path.")).toBeTruthy();
  });

  it("names the model that wrote it, because a digest is only as good as its author", () => {
    render(
      <SummaryBand state={{ kind: "ready", result: digest() }} model="opencode-go/deepseek-v4-flash" onDismiss={() => {}} />,
    );
    expect(screen.getByText(/opencode-go\/deepseek-v4-flash/)).toBeTruthy();
  });

  it("says so when the window was truncated rather than implying full coverage", () => {
    render(
      <SummaryBand
        state={{ kind: "ready", result: digest({ coverage: { fromEventIndex: 0, toEventIndex: 900, mode: "nice", truncated: true } }) }}
        model={null}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/window truncated/)).toBeTruthy();
  });

  it("marks a digest taken mid-turn as still running", () => {
    render(
      <SummaryBand state={{ kind: "ready", result: digest({ phase: "running", runState: "running" }) }} model={null} onDismiss={() => {}} />,
    );
    expect(screen.getByText("still running")).toBeTruthy();
  });

  it("collapses to the headline and back", () => {
    render(<SummaryBand state={{ kind: "ready", result: digest() }} model={null} onDismiss={() => {}} />);
    const toggle = screen.getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    expect(screen.queryByText("It restricted the tool set and added a test.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("It restricted the tool set and added a test.")).toBeTruthy();
  });

  it("keeps what it read out of the way until asked, then shows it in order", () => {
    render(<SummaryBand state={{ kind: "ready", result: digest() }} model={null} onDismiss={() => {}} />);
    // The digest is the answer; the receipt for it is one click away.
    expect(screen.queryByText("The turn names summaryRuntime.ts, so read that first.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /how it read the turn/ }));

    expect(screen.getByText("The turn names summaryRuntime.ts, so read that first.")).toBeTruthy();
    expect(screen.getByText("read")).toBeTruthy();
  });

  it("counts the lookups, not the reasoning, on the closed disclosure", () => {
    render(<SummaryBand state={{ kind: "ready", result: digest() }} model={null} onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: /how it read the turn · 1 lookup$/ })).toBeTruthy();
  });

  it("says a lookup failed rather than showing it as an ordinary read", () => {
    render(
      <SummaryBand
        state={{
          kind: "ready",
          result: digest({ steps: [{ kind: "tool", name: "read", target: "gone.ts", failed: true }] }),
        }}
        model={null}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /how it read the turn/ }));
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("offers no disclosure for a run that recorded nothing", () => {
    render(
      <SummaryBand state={{ kind: "ready", result: digest({ steps: [] }) }} model={null} onDismiss={() => {}} />,
    );
    expect(screen.queryByText(/how it read the turn/)).toBeNull();
  });

  it("reports a failure as an alert rather than an empty band", () => {
    render(
      <SummaryBand state={{ kind: "error", message: "the model timed out" }} model={null} onDismiss={() => {}} />,
    );
    expect(screen.getByRole("alert").textContent).toBe("the model timed out");
  });

  it("dismisses", () => {
    const onDismiss = vi.fn();
    render(<SummaryBand state={{ kind: "ready", result: digest() }} model={null} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("the summarize control", () => {
  it("keeps one label and changes only what it promises", () => {
    const { rerender } = render(
      <SummaryControl state={{ kind: "idle" }} running={false} onSummarize={() => {}} />,
    );
    expect(screen.getByLabelText("Summarize this turn")).toBeTruthy();
    rerender(<SummaryControl state={{ kind: "idle" }} running onSummarize={() => {}} />);
    expect(screen.getByLabelText("Summarize what it is doing")).toBeTruthy();
  });

  it("is busy and unclickable while a digest is in flight", () => {
    const onSummarize = vi.fn();
    render(
      <SummaryControl
        state={{ kind: "pending", steps: [], thought: "" }}
        running={false}
        onSummarize={onSummarize}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onSummarize).not.toHaveBeenCalled();
  });

  it("summarizes on click", () => {
    const onSummarize = vi.fn();
    render(<SummaryControl state={{ kind: "idle" }} running={false} onSummarize={onSummarize} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSummarize).toHaveBeenCalledOnce();
  });
});
