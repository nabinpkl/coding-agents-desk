import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type { AgentDataSource } from "./data-source/AgentDataSource";
import {
  buildActivityDisplayItems,
  partitionEventBlocks,
  shellCommand,
} from "./activityDisplayItems";
import { LabeledTextBlock, RawDetails, RawJsonBlock } from "./ActivitySystemBlocks";
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

describe("event block partition", () => {
  it("folds metadata and the raw line away from an event that has content", () => {
    const layout = partitionEventBlocks({
      index: 12,
      ts: 1,
      type: "assistant",
      blocks: [
        { kind: "tool_use", tool: "Bash", summary: "ls", callId: "call-1" },
        { kind: "metadata", label: "Token Usage", text: "1,234 tokens" },
        { kind: "metadata", label: "Stop Reason", text: "tool_use" },
        { kind: "metadata", label: "Working Directory", text: "/repo" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ block }) => block.kind)).toEqual(["tool_use"]);
    expect(layout.folded.map((block) => block.label)).toEqual([
      "Token Usage",
      "Stop Reason",
      "Working Directory",
    ]);
    expect(layout.hasRawJson).toBe(true);
  });

  it("keeps metadata inline when it is the event's only content", () => {
    const layout = partitionEventBlocks({
      index: 13,
      ts: 1,
      type: "system",
      blocks: [
        { kind: "metadata", label: "Agent Message", text: "finished indexing" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ block }) => block.label)).toEqual(["Agent Message"]);
    expect(layout.folded).toEqual([]);
    expect(layout.hasRawJson).toBe(true);
  });

  it("keeps each inline block's original index so tool keys stay stable", () => {
    const layout = partitionEventBlocks({
      index: 14,
      ts: 1,
      type: "assistant",
      blocks: [
        { kind: "text", text: "running it" },
        { kind: "metadata", label: "Working Directory", text: "/repo" },
        { kind: "tool_use", tool: "Bash", summary: "ls" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ index }) => index)).toEqual([0, 2]);
  });
});

describe("shell command extraction", () => {
  it("prefers the raw input the macOS panel receives", () => {
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "Bash",
        summary: "git log --oneline",
        input: { command: "git log --oneline --graph --decorate --all" },
      }),
    ).toBe("git log --oneline --graph --decorate --all");
  });

  it("falls back to the summary when the wire dropped the input", () => {
    expect(shellCommand({ kind: "tool_use", tool: "shell", summary: "ls -la" })).toBe("ls -la");
    // Codex `shell` can carry argv rather than a command string.
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "shell",
        summary: "ls -la",
        input: { command: ["bash", "-lc", "ls -la"] },
      }),
    ).toBe("ls -la");
  });

  it("returns null for tools that do not run a shell command", () => {
    expect(shellCommand({ kind: "tool_use", tool: "Read", summary: "Read App.tsx" })).toBeNull();
    expect(shellCommand({ kind: "text", text: "prose" })).toBeNull();
  });
});

describe("raw drawer", () => {
  it("holds the metadata and only fetches the raw line from the nested disclosure", async () => {
    const exact = '{"type":"assistant"}';
    const fetchRawEvent = vi.fn(async () => exact);
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawDetails
          metadata={[
            { kind: "metadata", label: "Token Usage", text: "1,234 tokens" },
            { kind: "metadata", label: "Working Directory", text: "/repo" },
          ]}
          source="claude"
          sessionId="session"
          eventIndex={12}
          includesRawJson
        />
      </DataSourceProvider>,
    );

    const drawers = container.querySelectorAll("details");
    expect(drawers.length).toBe(2);
    expect(drawers[0]?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Token Usage")).toBeTruthy();
    expect(screen.getByText("Working Directory")).toBeTruthy();

    fireEvent.click(screen.getByText("Raw"));
    expect(fetchRawEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Raw JSON"));
    await waitFor(() => expect(fetchRawEvent).toHaveBeenCalledTimes(1));
    expect(screen.getByText(exact)).toBeTruthy();
  });

  it("renders nothing when the event has no metadata and no raw line", () => {
    const { container } = render(
      <DataSourceProvider source={source(async () => "")}>
        <RawDetails
          metadata={[]}
          source="claude"
          sessionId="session"
          eventIndex={12}
          includesRawJson={false}
        />
      </DataSourceProvider>,
    );

    expect(container.querySelector("details")).toBeNull();
  });
});
