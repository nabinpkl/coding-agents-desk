import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTailRow, SegmentEventRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

afterEach(() => vi.useRealTimers());

const ctx: EventRowContext = {
  session: { source: "claude", sessionId: "session", mode: "nice" },
  rawSource: "addressable",
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

  // On a thinking-heavy turn the trace is most of what is on the row, so a trace
  // that snapped while the prose beside it typed read as a glitch. Both reveal.
  it("reveals a streaming reasoning trace the same way it reveals prose", () => {
    vi.useFakeTimers();
    const { container } = renderLive(
      tail([
        { kind: "reasoning", text: "Weighing the two readings of the excerpt" },
        { kind: "text", text: "Reading the failing line" },
      ]),
    );
    // Mid-reveal both are partial: neither has arrived whole while the other types.
    act(() => vi.advanceTimersByTime(33));
    expect(container.textContent).not.toContain("Weighing the two readings of the excerpt");

    for (let i = 0; i < 200; i++) {
      act(() => vi.advanceTimersByTime(33));
      if (container.textContent?.includes("Weighing the two readings of the excerpt")) break;
    }
    expect(container.textContent).toContain("Weighing the two readings of the excerpt");
    expect(container.textContent).toContain("Reading the failing line");
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
    // Identical text: the live marker is a pulse and a label, so it adds nothing
    // a reader has to re-read when the transcript takes the message over.
    expect(live.textContent).toBe(renderLanded(ev).container.textContent);
  });

  // Thinking and calls with no prose is a `tool` row, whose heading carries the call's intent.
  // The thinking used to wrap beside that heading and run into it.
  it("puts a tool row's thinking under its heading, not beside it", () => {
    const trace = "Checking the tree first";
    const deepest = (container: HTMLElement) =>
      [...container.querySelectorAll("*")].filter((el) => el.textContent?.includes(trace)).at(-1);

    const toolRow = tail([
      { kind: "reasoning", text: trace },
      {
        kind: "tool_use",
        tool: "Bash",
        summary: "git status",
        callId: "call_1",
        input: { command: "git status", description: "Show working tree status" },
      },
    ]);
    toolRow.phase = "complete";
    expect(deepest(renderLive(toolRow).container)?.closest(".clear-left")).not.toBeNull();

    // A thinking row's heading is a bare chevron, so its trace still starts beside it.
    const thinkingRow = tail([{ kind: "reasoning", text: trace }]);
    thinkingRow.phase = "complete";
    expect(deepest(renderLive(thinkingRow).container)?.closest(".clear-left")).toBeNull();
  });

  it("keeps a same-event tool result behind the call's collapsed disclosure", () => {
    const ev = tail([
      { kind: "tool_use", tool: "shell", summary: "git status", callId: "call-shell" },
      { kind: "tool_result", preview: "On branch main", callId: "call-shell" },
    ]);
    ev.phase = "complete";

    const live = renderLive(ev);
    expect(live.container.textContent).not.toContain("On branch main");
    expect(live.getByRole("button", { name: /git status/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("marks itself live without taking a row for the marker", () => {
    const ev = tail([{ kind: "text", text: "Working" }]);
    ev.phase = "complete";
    const live = renderLive(ev);
    // Nice omits the repeated Assistant role chip from both forms, and prose does not fold, so
    // there is no toggle either. Live-ness rides the heading as a pulse and an accessible label,
    // not a text band.
    expect(live.container.textContent).not.toContain("assistant");
    expect(live.getByLabelText("streaming")).toBeDefined();
    expect(live.container.querySelector("button[aria-expanded]")).toBeNull();
    expect(live.container.textContent).toBe(
      renderLanded(ev).container.textContent,
    );
  });
});
