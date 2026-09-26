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
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import {
  SegmentEventRow,
  UserRow,
  showEventRoleLabel,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// @git-diff-view and next-themes do not run under jsdom. Markdown stays REAL:
// whether reasoning renders its markup is the whole point of one test below.
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

const CTX: EventRowContext = {
  session: { source: "claude", sessionId: "session-1", mode: "raw" },
  rawSource: "addressable",
  expandedTools: new Set(),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: true,
};
const NICE_CTX: EventRowContext = {
  ...CTX,
  session: { ...CTX.session, mode: "nice" },
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
  it("removes Assistant and Reasoning labels in Nice while Raw keeps them", () => {
    expect(showEventRoleLabel("nice", "assistant")).toBe(false);
    expect(showEventRoleLabel("nice", "reasoning")).toBe(false);
    expect(showEventRoleLabel("raw", "assistant")).toBe(true);

    const assistant = renderRow(
      <SegmentEventRow
        ev={event({ type: "assistant", blocks: [{ kind: "text", text: "answer body" }] })}
        ctx={NICE_CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(assistant.queryByText("assistant")).toBeNull();
    assistant.unmount();

    const reasoning = renderRow(
      <SegmentEventRow
        ev={event({ type: "reasoning", blocks: [{ kind: "reasoning", text: "trace body" }] })}
        ctx={NICE_CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(reasoning.queryByText("reasoning")).toBeNull();
    reasoning.unmount();

    const raw = renderRow(
      <SegmentEventRow
        ev={event({ type: "assistant", blocks: [{ kind: "text", text: "raw answer" }] })}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(raw.getByText("assistant")).toBeTruthy();
  });

  it("leaves an expanded tool call to its own chip and its own chevron, and no second one", () => {
    expect(showEventRoleLabel("nice", "tool")).toBe(false);
    expect(showEventRoleLabel("nice", "user")).toBe(true);
    expect(showEventRoleLabel("raw", "tool")).toBe(true);

    const toolRow = (isCollapsed: boolean) => (
      <SegmentEventRow
        ev={event({
          type: "assistant",
          blocks: [{ kind: "tool_use", tool: "Read", summary: "Read file", callId: "call-1" }],
        })}
        ctx={NICE_CTX}
        isFirst
        isLast
        isCollapsed={isCollapsed}
        onToggle={() => {}}
        isHighlighted={false}
      />
    );

    const row = renderRow(toolRow(false));
    expect(row.queryByText("tool")).toBeNull();
    // One disclosure rather than two. The heading's chevron and the call's own sat next to each
    // other and opened the same row to the eye, and in Nice the heading held nothing else.
    expect(row.container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    expect(row.queryByLabelText("collapse event")).toBeNull();
    // Nothing else is on the heading line, so the call does not drop below it.
    expect(row.getByRole("button", { name: /Read file/ }).closest(".clear-left")).toBeNull();
    row.unmount();

    // Collapsed, the call's own header is not on screen, so the heading keeps the chevron that is
    // the only way back into the row -- which is what a Fold all leaves a reader holding.
    const folded = renderRow(toolRow(true));
    expect(folded.getByLabelText("expand event")).toHaveAttribute("aria-expanded", "false");
  });

  it("separates Nice tool and text rows into tightly spaced cards", () => {
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

    const textCard = view.container.querySelector('[data-feed-card="text"]');
    const toolCard = view.container.querySelector('[data-feed-card="tool"]');
    expect(textCard?.className).toContain("rounded-md");
    // The two row surfaces are named rather than painted, so a session inside a shaded Bot card
    // can hand them its colour and every other reader of this feed gets the grey they always had.
    expect(textCard?.className).toContain("session-view-row");
    expect(toolCard?.className).toContain("rounded-md");
    expect(toolCard?.className).toContain("session-view-row-tool");
    expect(textCard?.className).not.toContain("border-dashed");
    expect(toolCard?.className).not.toContain("border-dashed");
    expect(textCard?.parentElement?.className).toContain("py-[0.1em]");
    expect(toolCard?.parentElement?.className).toContain("py-[0.1em]");
  });

  it("gives Nice feed cards a gutter that is a share of the column, not a fixed 24px", () => {
    const view = renderRow(
      <>
        <UserRow
          ev={event({ type: "user" })}
          ctx={NICE_CTX}
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
        <SegmentEventRow
          ev={event({ index: 8 })}
          ctx={NICE_CTX}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </>,
    );

    expect(view.container.children).toHaveLength(2);
    for (const row of view.container.children) {
      // Three percent of the column, floored at 12px and capped at 24px. The cap is reached at an
      // 800px column, so the full-page thread view is the 24px it has always been, while a Bot
      // card's open session and a phone both land on the floor.
      expect(row.className).toContain("px-[clamp(0.75rem,3%,1.5rem)]");
      expect(row.className).not.toContain("px-[0.55em]");
    }
  });

  it("puts what the user said on the right, in a card narrower than the row", () => {
    const { container } = renderRow(
      <UserRow
        ev={event({ type: "user" })}
        ctx={CTX}
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("justify-end");
    // Bounded, or a long prompt fills the row and the side it is on stops being readable.
    expect(row.firstElementChild?.className).toContain("max-w-[85%]");
  });

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
    // A float floors at its min-content width, and the tool-intent span inside caps itself in
    // `ch`, so without this the heading grew past a phone's column and gave the whole transcript
    // a horizontal scroll. jsdom has no layout to measure, so the cap is asserted as the class.
    expect(heading?.className).toContain("max-w-full");
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

