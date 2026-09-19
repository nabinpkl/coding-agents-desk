import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { CompactionRow } from "@/features/activity-feed/blocks/CompactionRow";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/blocks/DiffBlock", () => ({ DiffBlock: () => <div /> }));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

const CTX: EventRowContext = {
  session: { source: "claude", sessionId: "session-1", mode: "nice" },
  rawSource: "addressable",
  expandedTools: new Set(),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: true,
};

function banner(blocks: ActivityEvent["blocks"]): ActivityEvent {
  return { index: 4, ts: Date.UTC(2026, 8, 15, 21, 17, 28), type: "system", blocks };
}

function renderRow(ev: ActivityEvent) {
  return render(
    <DataSourceProvider source={DATA_SOURCE}>
      <CompactionRow ev={ev} ctx={CTX} />
    </DataSourceProvider>,
  );
}

describe("CompactionRow", () => {
  it("shows the summary the context was replaced with, and folds it away", () => {
    renderRow(banner([{ kind: "compaction", text: "Summary:\n1. Primary Request" }, { kind: "raw" }]));
    const chip = screen.getByRole("button", { name: /Context compacted/ });
    expect(chip).toHaveAttribute("aria-expanded", "true");
    // Rendered as Markdown: the summariser's numbered sections arrive as a list, not as digits.
    expect(screen.getByRole("listitem")).toHaveTextContent("Primary Request");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Primary Request/)).toBeNull();

    fireEvent.click(chip);
    expect(screen.getByRole("listitem")).toHaveTextContent("Primary Request");
  });

  it("offers nothing to open when the compaction carries no summary", () => {
    renderRow(banner([{ kind: "compaction" }, { kind: "raw" }]));
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Context compacted/ })).toBeNull();
  });
});
