/**
 * What Nice draws each row on: assistant prose and reasoning on the transcript's own ground, and a
 * card for the work beside them -- tool calls and their results.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SegmentEventRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({
  DiffBlock: () => <div data-testid="diff-block" />,
}));

const DATA_SOURCE = stubDataSource({
  fetchEventsPage: async () => ({ events: [], windowStart: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

const NICE_CTX: EventRowContext = {
  session: { source: "claude", sessionId: "session-1", mode: "nice" },
  rawSource: "addressable",
  expandedTools: new Set(),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: true,
};

function renderRow(node: React.ReactNode) {
  return render(<DataSourceProvider source={DATA_SOURCE}>{node}</DataSourceProvider>);
}

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    index: 7,
    ts: Date.UTC(2026, 0, 1, 12, 0, 0),
    type: "assistant",
    blocks: [{ kind: "text", text: "plain body" }],
    ...overrides,
  };
}

describe("Nice row surfaces", () => {
  it("runs Nice assistant prose on the ground and lifts tool rows onto tightly spaced cards", () => {
    const view = renderRow(
      <>
        <SegmentEventRow
          ev={event({ type: "assistant", blocks: [{ kind: "text", text: "answer body" }] })}
          ctx={NICE_CTX}
          isFirst
          isLast={false}
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
        <SegmentEventRow
          ev={event({
            index: 8,
            blocks: [{ kind: "tool_use", tool: "Read", summary: "Read file", callId: "call-1" }],
          })}
          ctx={NICE_CTX}
          isFirst={false}
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </>,
    );

    const prose = view.container.querySelector('[data-feed-card="plain"]');
    const toolCard = view.container.querySelector('[data-feed-card="tool"]');
    // No fill and no visible edge: what the agent said is the transcript, not an object on it.
    expect(prose?.className).not.toMatch(/session-view-row/);
    expect(prose?.className).toContain("border-transparent");
    expect(toolCard?.className).toContain("rounded-md");
    // The row surface is named rather than painted, so a session inside a shaded Bot card can
    // hand it its colour and every other reader of this feed gets the grey it always had.
    expect(toolCard?.className).toContain("session-view-row-tool");
    expect(prose?.className).not.toContain("border-dashed");
    expect(toolCard?.className).not.toContain("border-dashed");
    expect(prose?.parentElement?.className).toContain("py-[0.1em]");
    expect(toolCard?.parentElement?.className).toContain("py-[0.1em]");
  });

  it("runs reasoning on the ground too, and gives a call inside an assistant message a card of its own", () => {
    const view = renderRow(
      <>
        <SegmentEventRow
          ev={event({ type: "reasoning", blocks: [{ kind: "text", text: "thinking it over" }] })}
          ctx={NICE_CTX}
          isFirst
          isLast={false}
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
        <SegmentEventRow
          ev={event({
            index: 9,
            blocks: [
              { kind: "text", text: "Reading it now." },
              { kind: "tool_use", tool: "Read", summary: "Read file", callId: "call-2" },
            ],
          })}
          ctx={NICE_CTX}
          isFirst={false}
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </>,
    );

    const [reasoning, prose] = view.container.querySelectorAll('[data-feed-card="plain"]');
    expect(reasoning?.textContent).toContain("thinking it over");
    expect(reasoning?.className).not.toMatch(/session-view-row/);
    expect(reasoning?.className).toContain("border-transparent");
    const call = prose?.querySelector('[data-feed-card="tool"]');
    expect(call?.className).toContain("session-view-row-tool");
    expect(call?.querySelector("button")?.textContent).toMatch(/Read/);
    expect(call?.textContent).not.toContain("Reading it now.");
  });
});
