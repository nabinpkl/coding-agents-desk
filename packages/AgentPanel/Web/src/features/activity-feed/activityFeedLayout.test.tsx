import { describe, expect, it } from "vitest";
import { leadEvent } from "@/features/activity-feed/activityDisplayItems";
import { buildFeedLayout, partitionEventBlocks } from "@/features/activity-feed/activityFeedLayout";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// The Claude adapter appends a Working Directory block to nearly every line,
// which is what defeated both "is this event only X?" predicates below.
const CWD = { kind: "metadata", label: "Working Directory", text: "/repo" } as const;

describe("feed layout", () => {
  it("pairs a result into its call even when the line carries metadata", () => {
    const events: ActivityEvent[] = [
      {
        index: 10,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }, CWD, { kind: "raw" }],
      },
      {
        index: 11,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "result", callId: "call-1" },
          CWD,
          { kind: "raw" },
        ],
      },
    ];

    const layout = buildFeedLayout(events);
    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([10]);
    expect(layout.allEventIds).toEqual([10]);

    // The result event surrendered its row, so its metadata and raw line ride
    // into the tool call rather than disappearing.
    const paired = layout.pairedToolResults.get("call-1");
    expect(paired?.eventIndex).toBe(11);
    expect(paired?.includesRawEvent).toBe(true);
    expect(paired?.metadata.map((block) => block.label)).toEqual(["Working Directory"]);
  });

  it("gives only the first result of an event the raw line and metadata", () => {
    const layout = buildFeedLayout([
      {
        index: 20,
        ts: 1,
        type: "assistant",
        blocks: [
          { kind: "tool_use", tool: "Read", callId: "call-1" },
          { kind: "tool_use", tool: "Read", callId: "call-2" },
        ],
      },
      {
        index: 21,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "first", callId: "call-1" },
          { kind: "tool_result", preview: "second", callId: "call-2" },
          CWD,
          { kind: "raw" },
        ],
      },
    ]);

    expect(layout.pairedToolResults.get("call-1")?.includesRawEvent).toBe(true);
    expect(layout.pairedToolResults.get("call-1")?.metadata).toHaveLength(1);
    expect(layout.pairedToolResults.get("call-2")?.includesRawEvent).toBe(false);
    expect(layout.pairedToolResults.get("call-2")?.metadata).toEqual([]);
  });

  it("keeps an event holding more than results as its own row", () => {
    const layout = buildFeedLayout([
      {
        index: 30,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }],
      },
      {
        index: 31,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "result", callId: "call-1" },
          { kind: "text", text: "and one more thing" },
        ],
      },
    ]);

    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([30, 31]);
    expect(layout.pairedToolResults.size).toBe(0);
  });

  it("keeps a result with no matching call as its own row", () => {
    const layout = buildFeedLayout([
      {
        index: 40,
        ts: 1,
        type: "user",
        blocks: [{ kind: "tool_result", preview: "orphan", callId: "call-missing" }, CWD],
      },
    ]);

    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([40]);
    expect(layout.pairedToolResults.size).toBe(0);
  });

  it("renders a compaction banner even when the line carries metadata", () => {
    const layout = buildFeedLayout([
      {
        index: 50,
        ts: 1,
        type: "system",
        blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }],
      },
    ]);

    expect(layout.items.map((item) => item.kind)).toEqual(["compaction"]);
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
