/**
 * What a `SendUserFile` call reads as in the feed.
 *
 * Rendered through a real row rather than through the block alone, because the defect was the
 * whole row: the header named the delivery mode, the sentence explaining the files was in a key
 * nothing rendered, and the result repeated every absolute path beside a delivery handle.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SegmentEventRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import { withoutFileHandles } from "@/features/activity-feed/blocks/SentFilesBlock";
import { toolIntent } from "@/features/activity-feed/rows/activityEventText";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";

vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({ DiffBlock: () => <div /> }));

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
    // Resolved by the sidecar, which is what the panel addresses a picture by.
    files: [`${ROOT}/cull-ad-1-fit.png`, `${ROOT}/cull-lc-1-fit.png`],
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

function renderCall(
  { expanded = true, source = stubDataSource({}), ev = call }:
    { expanded?: boolean; source?: AgentDataSource; ev?: ActivityEvent } = {},
) {
  const ctx: EventRowContext = {
    session: { source: "claude", sessionId: "session-1", mode: "nice" },
    rawSource: "addressable",
    expandedTools: new Set(expanded ? ["call-1"] : []),
    onToggleTool: () => {},
    pairedToolResults: new Map([["call-1", delivered]]),
    showCacheHits: false,
  };
  return render(
    <DataSourceProvider source={source}>
      <SegmentEventRow
        ev={ev}
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
    // The path is still reachable, on the item that carries it.
    expect(screen.getByText("cull-ad-1-fit.png").closest("li")?.getAttribute("title"))
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

  it("draws the pictures themselves, addressed by their place in the call", () => {
    const eventFileUrl = vi.fn(
      (_s, event: number, block: number, file: number) => `/file/${event}-${block}-${file}`,
    );
    renderCall({ source: stubDataSource({ eventFileUrl }) });

    const opened = screen.getAllByRole("button", { name: /^Open .+ larger$/ });
    expect(opened).toHaveLength(2);
    // The call's own event and block, and one index per file: no path travels in the request,
    // whichever part of the row is doing the asking.
    expect(new Set(eventFileUrl.mock.calls.map((args) => args.slice(1).join(","))))
      .toEqual(new Set(["7,0,0", "7,0,1"]));
  });

  it("links a file it cannot draw, rather than asking for it as a picture", () => {
    const eventFileUrl = vi.fn(() => "/file/report");
    const report = `${ROOT}/triage-report.md`;
    renderCall({
      source: stubDataSource({ eventFileUrl }),
      ev: {
        ...call,
        blocks: [{
          ...call.blocks[0]!,
          input: { files: [report], caption: CAPTION, status: "normal" },
          files: [report],
        }],
      },
    });

    // A page or a report the reader was sent is something to OPEN, and its name was the only
    // thing in the row: a path in a temp directory they cannot reach from a browser.
    const link = screen.getByRole("link", { name: "triage-report.md" });
    expect(link.getAttribute("href")).toBe("/file/report");
    expect(link.getAttribute("target")).toBe("_blank");
    // Nothing the opened page can use to act as this panel.
    expect(link.getAttribute("rel")).toBe("noreferrer");
    // And still not a picture: nothing asks for it as one.
    expect(screen.queryByRole("button", { name: /^Open .+ larger$/ })).toBeNull();
  });

  it("stays a plain name where the transport has no address a browser can load", () => {
    // A relayed feed answers requests itself and has no URL to hand a new tab, so the row is
    // what it was before: the name, and nothing pretending to be openable.
    renderCall();

    expect(screen.getByText("cull-ad-1-fit.png").tagName).toBe("DIV");
    expect(screen.queryByRole("link", { name: "cull-ad-1-fit.png" })).toBeNull();
  });

  // The same reason a tool-returned picture rides its folded header: the picture is why the call
  // happened, and a reader scrolling past should not have to open the row to find that out.
  it("shows the pictures while the call is folded, and only once when it is open", () => {
    const eventFileUrl = vi.fn(() => "/file/one");
    const folded = renderCall({ expanded: false, source: stubDataSource({ eventFileUrl }) });
    expect(screen.getAllByRole("button", { name: /^Open .+ larger$/ })).toHaveLength(2);
    // Folded, the pictures ride the header line itself: the list they sit in is not drawn.
    expect(folded.container.querySelectorAll("li")).toHaveLength(0);
    folded.unmount();

    renderCall({ source: stubDataSource({ eventFileUrl }) });
    expect(screen.getAllByRole("button", { name: /^Open .+ larger$/ })).toHaveLength(2);
  });

  // A scratchpad gets swept and a branch gets switched, so a row can outlive the file it names.
  it("leaves the name behind when the picture is no longer there", () => {
    const { container } = renderCall({
      source: stubDataSource({ eventFileUrl: () => "/file/gone" }),
    });
    for (const image of container.querySelectorAll("img")) fireEvent.error(image);

    expect(screen.getByText("cull-ad-1-fit.png")).toBeDefined();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // And no chip reporting a failure the reader can do nothing about.
    expect(container.textContent).not.toContain("Image did not load");
  });

  it("leaves a picture the result already returned to the result", () => {
    const ctx = { ...delivered, images: [1] };
    const { container } = render(
      <DataSourceProvider source={stubDataSource({ eventImageUrl: () => "/img/8-1" })}>
        <SegmentEventRow
          ev={call}
          ctx={{
            session: { source: "claude", sessionId: "session-1", mode: "nice" },
            rawSource: "addressable",
            expandedTools: new Set(["call-1"]),
            onToggleTool: () => {},
            pairedToolResults: new Map([["call-1", ctx]]),
            showCacheHits: false,
          }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>,
    );
    // One picture, drawn where the result put it, rather than the same one twice.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/img/8-1");
  });

  it("keeps a result that says something other than which handles it minted", () => {
    expect(withoutFileHandles("Could not read /tmp/gone.png")).toBe("Could not read /tmp/gone.png");
    expect(withoutFileHandles("1 file delivered to user.\n  /a/b.png → file_uuid: x"))
      .toBe("1 file delivered to user.");
    expect(withoutFileHandles(undefined)).toBe("");
  });
});
