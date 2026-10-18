/**
 * What a person said, as a row: no role label, and a chevron only on a message long enough to fold,
 * at its end rather than ahead of it.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { UserRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({
  DiffBlock: () => <div data-testid="diff-block" />,
}));

const DATA_SOURCE = stubDataSource({
  fetchEventsPage: async () => ({ events: [], windowStart: 0, usage: null }),
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

function renderRow(node: React.ReactNode) {
  return render(<DataSourceProvider source={DATA_SOURCE}>{node}</DataSourceProvider>);
}

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    index: 7,
    ts: Date.UTC(2026, 0, 1, 12, 0, 0),
    type: "user",
    blocks: [{ kind: "text", text: "plain body" }],
    ...overrides,
  };
}

describe("a user message row", () => {
  it("still reports collapse state to assistive tech", () => {
    renderRow(
      <UserRow
        ev={event({ type: "user", blocks: [{ kind: "text", text: "word ".repeat(80) }] })}
        ctx={CTX}
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.getByLabelText("expand event")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a short message as its text alone, with no label and no chevron", () => {
    const { container } = renderRow(
      <UserRow
        ev={event({ type: "user", blocks: [{ kind: "text", text: "do 1" }] })}
        ctx={CTX}
        // Collapse-all reaches user rows too; a short one has nothing to fold.
        isCollapsed
        onToggle={() => {}}
        isHighlighted={false}
      />,
    );
    expect(screen.getByText("do 1")).toBeTruthy();
    expect(screen.queryByText("user")).toBeNull();
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("ends a long message in its chevron, open or folded", () => {
    const long = event({ type: "user", blocks: [{ kind: "text", text: "line\n".repeat(7) + "last line" }] });
    const open = renderRow(
      <UserRow ev={long} ctx={CTX} isCollapsed={false} onToggle={() => {}} isHighlighted={false} />,
    );
    const card = open.container.querySelector(".max-w-\\[85\\%\\]")!;
    const toggle = open.getByLabelText("collapse event");
    // After the body, not ahead of it: nothing in the card follows the chevron.
    expect(card.textContent?.trim().endsWith("last line")).toBe(true);
    expect(card.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(toggle.closest("div")?.nextElementSibling).toBeNull();
    expect(open.queryByText("user")).toBeNull();
    open.unmount();

    const folded = renderRow(<UserRow ev={long} ctx={CTX} isCollapsed onToggle={() => {}} isHighlighted={false} />);
    const expand = folded.getByLabelText("expand event");
    expect(expand.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});
