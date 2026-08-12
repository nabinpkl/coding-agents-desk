import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTailRow, SegmentEventRow, type EventRowContext } from "./ActivityEventRows";
import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";

afterEach(() => vi.useRealTimers());

const ctx: EventRowContext = {
  session: { source: "claude", sessionId: "session", mode: "nice" },
  expandedTools: new Set(),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: false,
};

function tail(blocks: ActivityBlock[]): ActivityEvent {
  return {
    id: "claude-live:msg_1",
    // What the mirror actually carries: it has no transcript position yet.
    index: -1,
    revision: 1,
    phase: "streaming",
    ts: 1,
    type: "assistant",
    messageId: "msg_1",
    blocks,
  };
}

/** The same message once the transcript owns it: a durable row, no live marker. */
function landed(ev: ActivityEvent): ActivityEvent {
  return { ...ev, index: 12, phase: "complete" };
}

function renderLive(ev: ActivityEvent) {
  return render(
    <LiveTailRow ev={ev} ctx={ctx} isCollapsed={false} onToggle={() => {}} />,
  );
}

function renderLanded(ev: ActivityEvent) {
  return render(
    <SegmentEventRow
      ev={landed(ev)}
      ctx={ctx}
      isFirst
      isLast
      isCollapsed={false}
      onToggle={() => {}}
      isHighlighted={false}
    />,
  );
}

describe("LiveTailRow", () => {
  it("reveals streaming assistant prose progressively", () => {
    vi.useFakeTimers();
    renderLive(tail([{ kind: "text", text: "Hello streaming world" }]));
    expect(screen.getByLabelText(/streaming/)).toBeDefined();

    // Advances through the reveal until the full text is present.
    for (let i = 0; i < 200; i++) {
      act(() => vi.advanceTimersByTime(33));
      if (screen.queryByText(/Hello streaming world/)) break;
    }
    expect(screen.getByText(/Hello streaming world/)).toBeDefined();
  });

  it("renders a completed live message at full text", () => {
    const complete = tail([{ kind: "text", text: "Done" }]);
    complete.phase = "complete";
    renderLive(complete);
    expect(screen.getByText("Done")).toBeDefined();
  });

  // The defect this row exists to avoid: the tail used to be its own card that
  // showed prose as pre-wrapped source and tools as bare names, so the handoff to
  // the transcript re-chromed the row, re-rendered the prose as Markdown, and
  // relabelled every tool -- reflowing the paragraph mid-read. These compare the
  // live render against the durable one and demand they agree.
  it("renders streaming prose as the Markdown it will still be once it lands", () => {
    const ev = tail([{ kind: "text", text: "A **bold** claim" }]);
    ev.phase = "complete";
    const live = renderLive(ev).container;
    expect(live.querySelector("strong")?.textContent).toBe("bold");
    // No literal asterisks: that is what the reader saw before, then watched vanish.
    expect(live.textContent).not.toContain("**");
    expect(live.querySelector("strong")?.textContent).toBe(
      renderLanded(ev).container.querySelector("strong")?.textContent,
    );
  });

  it("labels a streaming tool call the way the durable row will", () => {
    const ev = tail([
      { kind: "tool_use", tool: "Bash", summary: "cd /Users/dev", callId: "call_1" },
    ]);
    ev.phase = "complete";
    const live = renderLive(ev).container;
    expect(live.textContent).toContain("Bash");
    expect(live.textContent).toContain("cd /Users/dev");
    expect(live.textContent).not.toContain("→");
    // Identical text, down to the role chip ("tool", because this event is a call
    // with no prose): the live marker is a pulse and a label, so it adds nothing
    // a reader has to re-read when the transcript takes the message over.
    expect(live.textContent).toBe(renderLanded(ev).container.textContent);
  });

  it("marks itself live without taking a row for the marker", () => {
    const ev = tail([{ kind: "text", text: "Working" }]);
    ev.phase = "complete";
    const live = renderLive(ev);
    // The chip is the role, same as the durable row; live-ness rides the heading
    // as a pulse and a label, not as a band above the prose. So the marker adds
    // no text, and its removal at handoff moves nothing.
    expect(live.container.textContent).toContain("assistant");
    expect(live.getByLabelText(/, streaming/)).toBeDefined();
    expect(live.container.textContent).toBe(
      renderLanded(ev).container.textContent,
    );
  });
});
