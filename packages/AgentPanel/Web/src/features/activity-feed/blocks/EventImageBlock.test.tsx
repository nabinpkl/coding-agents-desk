import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import {
  SegmentEventRow,
  UserRow,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";

vi.mock("@/features/activity-feed/blocks/DiffBlock", () => ({ DiffBlock: () => <div /> }));

const CTX: EventRowContext = {
  session: { source: "claude", sessionId: "session-1", mode: "nice" },
  rawSource: "addressable",
  expandedTools: new Set(),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: false,
};

const PASTED: ActivityEvent = {
  index: 12,
  ts: Date.UTC(2026, 8, 14),
  type: "user",
  humanTurn: true,
  blocks: [
    { kind: "text", text: "[Image #3] what about this" },
    { kind: "image", mediaType: "image/png" },
  ],
};

function renderRow(ctx: EventRowContext, source: Partial<AgentDataSource>) {
  return render(
    <DataSourceProvider source={stubDataSource(source)}>
      <UserRow ev={PASTED} ctx={ctx} isCollapsed={false} onToggle={() => {}} isHighlighted={false} />
    </DataSourceProvider>,
  );
}

describe("an image in a message", () => {
  it("shows a thumbnail addressed at its own row and block, and opens it larger", () => {
    const eventImageUrl = vi.fn(() => "/img/12-1");
    renderRow(CTX, { eventImageUrl });

    // The mode travels with the index, because the same index names a different line in each.
    expect(eventImageUrl).toHaveBeenCalledWith(CTX.session, 12, 1);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open image larger" }));
    const opened = screen.getByRole("img", { name: "Image from this message" });
    expect(opened.getAttribute("src")).toBe("/img/12-1");

    fireEvent(screen.getByLabelText("Image"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("img", { name: "Image from this message" })).toBeNull();
  });

  it("shows the image a tool returned inside the open call, and says nothing about it being empty", () => {
    const call: ActivityEvent = {
      index: 20,
      ts: Date.UTC(2026, 8, 14),
      type: "assistant",
      blocks: [{ kind: "tool_use", tool: "Read", summary: "shot.png", callId: "call-1" }],
    };
    const eventImageUrl = vi.fn(() => "/img/21-1");
    const ctx: EventRowContext = {
      ...CTX,
      expandedTools: new Set(["call-1"]),
      pairedToolResults: new Map([["call-1", {
        block: { kind: "tool_result", preview: "", callId: "call-1" },
        eventIndex: 21,
        blockIndex: 0,
        includesRawEvent: false,
        metadata: [],
        images: [1],
      }]]),
    };
    render(
      <DataSourceProvider source={stubDataSource({ eventImageUrl })}>
        <SegmentEventRow
          ev={call}
          ctx={ctx}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>,
    );

    // Addressed at the RESULT's line, which is where the bytes are, not at the call's.
    expect(eventImageUrl).toHaveBeenCalledWith(CTX.session, 21, 1);
    expect(screen.queryByText("(empty result)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open image larger" }));
    expect(screen.getByRole("img", { name: "Image this tool returned" })).toBeVisible();
  });

  it("shows the picture beside a folded call's header, and only once when the call is open", () => {
    const call: ActivityEvent = {
      index: 20,
      ts: Date.UTC(2026, 8, 14),
      type: "assistant",
      blocks: [{ kind: "tool_use", tool: "Read", summary: "shot.png", callId: "call-1" }],
    };
    const paired: PairedToolResult = {
      block: { kind: "tool_result", preview: "", callId: "call-1" },
      eventIndex: 21,
      blockIndex: 0,
      includesRawEvent: false,
      metadata: [],
      images: [1],
    };
    const eventImageUrl = vi.fn(() => "/img/21-1");
    const renderCall = (expanded: boolean) => (
      <DataSourceProvider source={stubDataSource({ eventImageUrl })}>
        <SegmentEventRow
          ev={call}
          ctx={{
            ...CTX,
            expandedTools: new Set(expanded ? ["call-1"] : []),
            pairedToolResults: new Map([["call-1", paired]]),
          }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>
    );
    const { rerender } = render(renderCall(false));

    expect(screen.getByRole("button", { expanded: false })).toBeVisible();
    expect(eventImageUrl).toHaveBeenCalledWith(CTX.session, 21, 1);
    expect(screen.getAllByRole("button", { name: "Open image larger" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open image larger" }));
    expect(screen.getByRole("img", { name: "Image this tool returned" })).toBeVisible();
    fireEvent(screen.getByLabelText("Image"), new Event("cancel", { cancelable: true }));

    rerender(renderCall(true));
    expect(screen.getAllByRole("button", { name: "Open image larger" })).toHaveLength(1);
  });

  it("says there is an image where this view has no address for it", () => {
    // A relayed transport, or a subagent's run read through its parent: the text still names an
    // image, so the row must not look as though it lost one.
    renderRow(CTX, { eventImageUrl: () => null });
    expect(screen.getByText("Image")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open image larger" })).toBeNull();
  });

  it("never builds an address from a feed whose indices are not this session's", () => {
    const eventImageUrl = vi.fn(() => "/img/wrong");
    renderRow({ ...CTX, rawSource: "unaddressable" }, { eventImageUrl });
    expect(eventImageUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open image larger" })).toBeNull();
  });

  it("says so when the picture fails to load, rather than leaving a broken frame", () => {
    renderRow(CTX, { eventImageUrl: () => "/img/gone" });
    const thumbnail = screen.getByRole("button", { name: "Open image larger" }).querySelector("img")!;
    fireEvent.error(thumbnail);
    expect(screen.getByText("Image did not load")).toBeVisible();
  });
});
