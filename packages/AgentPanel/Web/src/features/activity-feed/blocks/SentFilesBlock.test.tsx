/**
 * What a `SendUserFile` call reads as in the feed.
 *
 * Rendered through a real row rather than through the block alone, because the defect was the
 * whole row: the header named the delivery mode, the sentence explaining the files was in a key
 * nothing rendered, and the result repeated every absolute path beside a delivery handle.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SegmentEventRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import { withoutFileHandles } from "@/features/activity-feed/blocks/SentFilesBlock";
import { toolIntent } from "@/features/activity-feed/rows/activityEventText";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";

vi.mock("@/features/activity-feed/blocks/DiffBlock", () => ({ DiffBlock: () => <div /> }));

const ROOT = "/private/tmp/claude-501/-Users-dev-projects-agent-desk/8497f3ba/scratchpad";
const CAPTION = "Blue is imported-by, orange is imports.";

const call: ActivityEvent = {
  index: 7,
  ts: 1,
  type: "assistant",
  blocks: [{
    kind: "tool_use",
    tool: "SendUserFile",
    summary: "SendUserFile cull-ad-1-fit.png, cull-lc-1-fit.png",
    callId: "call-1",
    input: {
      files: [`${ROOT}/cull-ad-1-fit.png`, `${ROOT}/cull-lc-1-fit.png`],
      caption: CAPTION,
      status: "normal",
    },
  }],
};

const delivered: PairedToolResult = {
  block: {
    kind: "tool_result",
    callId: "call-1",
    preview: [
      "2 files delivered to user.",
      `  ${ROOT}/cull-ad-1-fit.png → file_uuid: 39cf5145-f317-4125-9c90-1deaebc97590`,
      `  ${ROOT}/cull-lc-1-fit.png → file_uuid: 966c9a50-353a-4df3-a573-49802e813181`,
    ].join("\n"),
  },
  eventIndex: 8,
  blockIndex: 0,
  includesRawEvent: false,
  metadata: [],
  images: [],
};

function renderCall() {
  const ctx: EventRowContext = {
    session: { source: "claude", sessionId: "session-1", mode: "nice" },
    rawSource: "addressable",
    expandedTools: new Set(["call-1"]),
    onToggleTool: () => {},
    pairedToolResults: new Map([["call-1", delivered]]),
    showCacheHits: false,
  };
  return render(
    <DataSourceProvider source={stubDataSource({})}>
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
}

describe("a call that hands files to the reader", () => {
  it("names the files it sent, not the temp directories they came from", () => {
    const { container } = renderCall();
    expect(screen.getByText("cull-ad-1-fit.png")).toBeDefined();
    expect(screen.getByText("cull-lc-1-fit.png")).toBeDefined();
    // The path is still reachable, on the row that carries it.
    expect(screen.getByText("cull-ad-1-fit.png").getAttribute("title"))
      .toBe(`${ROOT}/cull-ad-1-fit.png`);
    expect(container.textContent).not.toContain("file_uuid");
    // The delivery itself still reports, since a failure would report here too.
    expect(container.textContent).toContain("2 files delivered to user.");
  });

  it("says the tool's name once, though the summary carries it too", () => {
    const { container } = renderCall();
    const header = container.querySelector<HTMLElement>("button[aria-expanded]:not([aria-label])");
    expect(header?.textContent?.match(/SendUserFile/g)).toHaveLength(1);
    expect(header?.textContent).toContain("cull-ad-1-fit.png");
  });

  it("shows the sentence the files were sent with", () => {
    const { container } = renderCall();
    expect(container.textContent).toContain(CAPTION);
    // And in the heading above the call, where a description would be.
    expect(toolIntent(call)).toBe(CAPTION);
  });

  it("keeps a result that says something other than which handles it minted", () => {
    expect(withoutFileHandles("Could not read /tmp/gone.png")).toBe("Could not read /tmp/gone.png");
    expect(withoutFileHandles("1 file delivered to user.\n  /a/b.png → file_uuid: x"))
      .toBe("1 file delivered to user.");
    expect(withoutFileHandles(undefined)).toBe("");
  });
});
