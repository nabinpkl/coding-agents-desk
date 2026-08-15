/**
 * Render tests for one event row.
 *
 * These live apart from the feed on purpose: ActivityFeed drives a virtualizer,
 * and in jsdom every element measures 0px, so no row is ever visible through
 * that path. Rendering the rows directly is the only way these are testable at
 * all.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubDataSource } from "./data-source/stubDataSource";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type { AgentDataSource } from "./data-source/AgentDataSource";
import { SegmentEventRow, UserRow, type EventRowContext } from "./ActivityEventRows";
import type { ActivityEvent } from "./useSessionEventsStream";

// @git-diff-view and next-themes do not run under jsdom. Markdown stays REAL:
// whether reasoning renders its markup is the whole point of one test below.
vi.mock("./DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

const CTX: EventRowContext = {
  session: { source: "claude", sessionId: "session-1", mode: "raw" },
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

describe("event heading", () => {
  it("floats so the body's first line sits beside it rather than below", () => {
    // The recovered row: the heading used to be a full-width bar above the
    // body, costing every event ~30px that carried no content.
    const { container } = renderRow(
      <SegmentEventRow
        ev={event()}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const heading = container.querySelector("button[aria-expanded]");
    expect(heading?.className).toContain("float-left");
  });

  it("contains the float so a short body cannot let it escape the row", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event()}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const heading = container.querySelector("button[aria-expanded]");
    expect(heading?.parentElement?.className).toContain("flow-root");
  });

  it("moves the index and timestamp off the row and into its tooltip", () => {
    renderRow(
      <SegmentEventRow
        ev={event()}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    // Two values nobody scans by eye were spending permanent width on every row.
    expect(screen.queryByText("#7")).toBeNull();
    const heading = screen.getByLabelText("collapse event");
    expect(heading.getAttribute("title")).toContain("#7");
    expect(heading.getAttribute("title")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("still reports collapse state to assistive tech", () => {
    renderRow(
      <UserRow
        ev={event({ type: "user" })}
        ctx={CTX}
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.getByLabelText("expand event")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("prompt cache badge", () => {
  it("renders the cached and total input token counts next to a cache-bearing row", () => {
    renderRow(
      <SegmentEventRow
        ev={event({ cacheHit: { cached: 13184, input: 31428 } })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const badge = screen.getByLabelText("Prompt cache: 13,184 of 31,428 input tokens");
    expect(badge.textContent).toBe("cached 13,184 / 31,428");
    // The fraction still rides the tooltip and the accessible name.
    expect(badge.getAttribute("title")).toContain("(42%)");
  });

  it("puts the hit fraction in the tooltip, rounding half a percent down", () => {
    renderRow(
      <SegmentEventRow
        ev={event({ cacheHit: { cached: 1, input: 3 } })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const badge = screen.getByLabelText("Prompt cache: 1 of 3 input tokens");
    expect(badge.getAttribute("title")).toContain("(33%)");
  });

  it("is absent when the toggle is off even though the data is present", () => {
    renderRow(
      <SegmentEventRow
        ev={event({ cacheHit: { cached: 300, input: 800 } })}
        ctx={{ ...CTX, showCacheHits: false }}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.queryByText(/cached/)).toBeNull();
  });

  it("is absent when the event carries no cache data", () => {
    renderRow(
      <SegmentEventRow
        ev={event()}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.queryByText(/cached/)).toBeNull();
  });
});

describe("collapsed row", () => {
  it("shows a one-line gist instead of a bare chip", () => {
    renderRow(
      <SegmentEventRow
        ev={event({ blocks: [{ kind: "text", text: "first line\nsecond line" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.getByText("first line")).toBeTruthy();
    expect(screen.queryByText(/second line/)).toBeNull();
  });

  it("says so when an event has nothing to preview", () => {
    renderRow(
      <SegmentEventRow
        ev={event({ blocks: [{ kind: "text", text: "" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.getByText("(no content)")).toBeTruthy();
  });

  it("places the gist in its own formatting context so it clears the float", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event({ blocks: [{ kind: "text", text: "gist" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    // `truncate` carries overflow-hidden, which both clips the line and makes
    // this box sit beside the floated heading instead of under it.
    expect(container.querySelector(".truncate")).not.toBeNull();
  });
});

describe("reasoning", () => {
  it("renders its markdown instead of printing the asterisks", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event({
          type: "reasoning",
          blocks: [{ kind: "reasoning", text: "**Adjusting skip parameter handling**" }],
        })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe(
      "Adjusting skip parameter handling",
    );
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("keeps reading as commentary rather than headline", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event({ type: "reasoning", blocks: [{ kind: "reasoning", text: "thinking" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    // Italic sits on the wrapper so it cascades into the rendered prose.
    expect(container.querySelector(".italic")).not.toBeNull();
  });
});

describe("block flow", () => {
  it("lets prose flow beside the heading", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event({ type: "user", blocks: [{ kind: "text", text: "prose" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const wrapper = screen.getByText("prose").parentElement;
    expect(wrapper?.className ?? "").not.toContain("clear-left");
  });

  it("clears bordered blocks past the heading so they cannot sit under it", () => {
    const { container } = renderRow(
      <SegmentEventRow
        ev={event({
          blocks: [{ kind: "tool_use", tool: "Bash", summary: "ls", callId: "call-1" }],
        })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    // A floated box overlaps a following block box; only its line boxes are
    // pushed aside. Cards therefore have to clear it.
    expect(container.querySelectorAll(".clear-left").length).toBeGreaterThan(0);
  });
});
