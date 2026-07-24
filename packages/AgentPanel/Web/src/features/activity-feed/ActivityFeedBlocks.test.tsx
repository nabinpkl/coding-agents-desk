import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type { AgentDataSource } from "./data-source/AgentDataSource";
import { buildActivityDisplayItems } from "./activityDisplayItems";
import { LabeledTextBlock, RawJsonBlock } from "./ActivitySystemBlocks";
import type { ActivityEvent } from "./useSessionEventsStream";

function source(fetchRawEvent: AgentDataSource["fetchRawEvent"]): AgentDataSource {
  return {
    fetchEventsPage: async () => ({ events: [], total: 0 }),
    subscribeSessionEvents: () => () => {},
    fetchRawEvent,
  };
}

describe("complete activity blocks", () => {
  it("renders Plain and metadata text without HTML interpretation", () => {
    const { container, rerender } = render(
      <LabeledTextBlock block={{ kind: "plain", label: "Plain", text: "<img src=x onerror=alert(1)>" }} />,
    );
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();

    rerender(<LabeledTextBlock block={{ kind: "metadata", label: "Token Usage", text: "42" }} />);
    expect(screen.getByText("Token Usage")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("keeps Raw JSON collapsed and fetches the exact line only when opened", async () => {
    const exact = '{"type":"future","html":"<b>literal</b>"}';
    const fetchRawEvent = vi.fn(async () => exact);
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawJsonBlock source="claude" sessionId="session" eventIndex={7} />
      </DataSourceProvider>,
    );

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(fetchRawEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Raw JSON"));
    await waitFor(() =>
      expect(fetchRawEvent).toHaveBeenCalledWith(
        { source: "claude", sessionId: "session" },
        7,
      ),
    );
    expect(screen.getByText(exact)).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });

  it("keeps paired tool calls and results as separate source-line rows", () => {
    const events: ActivityEvent[] = [
      {
        index: 10,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }, { kind: "raw" }],
      },
      {
        index: 11,
        ts: 2,
        type: "user",
        blocks: [{ kind: "tool_result", preview: "result", callId: "call-1" }, { kind: "raw" }],
      },
    ];

    expect(buildActivityDisplayItems(events).map((item) => item.ev.index)).toEqual([10, 11]);
  });
});
