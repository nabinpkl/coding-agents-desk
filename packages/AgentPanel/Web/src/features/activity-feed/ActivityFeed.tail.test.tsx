import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTailRow } from "./ActivityFeed";
import type { ActivityEvent } from "./useSessionEventsStream";

afterEach(() => vi.useRealTimers());

function streamingTail(text: string): ActivityEvent {
  return {
    id: "claude-live:msg_1",
    index: 0,
    revision: 1,
    phase: "streaming",
    ts: 1,
    type: "assistant",
    messageId: "msg_1",
    blocks: [{ kind: "text", text }],
  };
}

describe("LiveTailRow", () => {
  it("reveals streaming assistant prose progressively", () => {
    vi.useFakeTimers();
    render(<LiveTailRow ev={streamingTail("Hello streaming world")} />);
    expect(screen.getByText(/streaming/i)).toBeDefined();

    // Advances through the reveal until the full text is present.
    for (let i = 0; i < 200; i++) {
      act(() => vi.advanceTimersByTime(33));
      if (screen.queryByText(/Hello streaming world/)) break;
    }
    expect(screen.getByText(/Hello streaming world/)).toBeDefined();
  });

  it("renders a completed live message at full text", () => {
    const complete = streamingTail("Done");
    complete.phase = "complete";
    render(<LiveTailRow ev={complete} />);
    expect(screen.getByText("Done")).toBeDefined();
  });

  it("preserves paragraph breaks while streaming (not collapsed into one)", () => {
    const ev = streamingTail("First paragraph.\n\nSecond paragraph.");
    ev.phase = "complete";
    const { container } = render(<LiveTailRow ev={ev} />);
    // The streaming tail renders the text verbatim, so the blank-line paragraph
    // boundary survives instead of being folded into a single paragraph.
    expect(container.textContent).toContain("First paragraph.\n\nSecond paragraph.");
  });
});
