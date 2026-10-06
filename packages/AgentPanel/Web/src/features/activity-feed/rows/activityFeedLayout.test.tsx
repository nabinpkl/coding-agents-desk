import { describe, expect, it } from "vitest";
import { leadEvent, isEventItem, type DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import { buildFeedLayout, partitionEventBlocks } from "@/features/activity-feed/rows/activityFeedLayout";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// The Claude adapter appends a Working Directory block to nearly every line,
// which is what defeated both "is this event only X?" predicates below.
const CWD = { kind: "metadata", label: "Working Directory", text: "/repo" } as const;

/** What the feed passes in Nice mode, which is the view a thread is read in. */
const NICE = { cluster: true, hideSystem: true } as const;

describe("feed layout", () => {
  it("carries the images each result returned into the call it answers", () => {
    // One line answering two calls, each with a picture. Matched by call, not by position.
    const events: ActivityEvent[] = [
      {
        index: 10,
        ts: 1,
        type: "assistant",
        blocks: [
          { kind: "tool_use", tool: "Read", callId: "call-1" },
          { kind: "tool_use", tool: "Read", callId: "call-2" },
        ],
      },
      {
        index: 11,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "", callId: "call-1" },
          { kind: "image", mediaType: "image/png", callId: "call-1" },
          { kind: "tool_result", preview: "", callId: "call-2" },
          { kind: "image", mediaType: "image/jpeg", callId: "call-2" },
          CWD,
          { kind: "raw" },
        ],
      },
    ];

    const layout = buildFeedLayout(events);
    // The images do not make the result event more than its results, so it still folds away.
    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([10]);
    expect(layout.pairedToolResults.get("call-1")?.images).toEqual([1]);
    expect(layout.pairedToolResults.get("call-2")?.images).toEqual([3]);
  });

  it("folds a same-event tool result into its call so the output stays behind the disclosure", () => {
    const event: ActivityEvent = {
      index: 12,
      ts: 1,
      type: "assistant",
      blocks: [
        { kind: "tool_use", tool: "shell", summary: "git status", callId: "call-shell" },
        { kind: "tool_result", preview: "On branch main", callId: "call-shell" },
      ],
    };

    const layout = buildFeedLayout([event]);
    const item = layout.items[0]!;
    expect(item.kind).toBe("segment_event");
    if (item.kind !== "segment_event") return;
    expect(item.ev.blocks).toHaveLength(1);
    expect(item.ev.blocks[0]?.kind).toBe("tool_use");
    expect(layout.pairedToolResults.get("call-shell")?.block.preview).toBe("On branch main");
  });

  it("draws a result's images inside it when the result keeps a row of its own", () => {
    const event: ActivityEvent = {
      index: 11,
      ts: 2,
      type: "user",
      blocks: [
        { kind: "tool_result", preview: "", callId: "call-out-of-window" },
        { kind: "image", mediaType: "image/png", callId: "call-out-of-window" },
        { kind: "image", mediaType: "image/png" },
      ],
    };

    // The second image answers no result here, so it stays a block of its own.
    expect(partitionEventBlocks(event).inline.map(({ index, images }) => [index, images])).toEqual([
      [0, [1]],
      [2, undefined],
    ]);
  });

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
    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([10]);
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

    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([30, 31]);
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

    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([40]);
    expect(layout.pairedToolResults.size).toBe(0);
  });

  // Claude writes a skill as three records: the call, a `Launching skill:` result, and the whole
  // skill as a separate harness-written user message. The third one is what these pin.
  const skillCall: ActivityEvent = {
    index: 80,
    ts: 1,
    type: "assistant",
    blocks: [
      { kind: "tool_use", tool: "Skill", callId: "call-1", summary: "Skill artifact-design" },
      { kind: "raw" },
    ],
  };
  const launching: ActivityEvent = {
    index: 81,
    ts: 2,
    type: "user",
    blocks: [
      { kind: "tool_result", preview: "Launching skill: artifact-design", callId: "call-1" },
      CWD,
      { kind: "raw" },
    ],
  };
  const skillText = "# Artifact design\n\nApproach this as the design lead at a small studio.";

  it("folds a skill's body into the call that activated it", () => {
    const layout = buildFeedLayout(
      [
        skillCall,
        launching,
        { index: 82, ts: 3, type: "user", blocks: [{ kind: "text", text: skillText }, CWD, { kind: "raw" }] },
      ],
      NICE,
    );

    // One row for all three: the call. The body used to be a right-aligned USER card holding
    // several hundred lines of instructions attributed to the reader.
    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([80]);
    const body = layout.pairedToolResults.get("call-1")?.skillBody;
    expect(body?.text).toContain("Approach this as the design lead");
    // The folded record's own raw line and metadata ride into the call, as a paired result's do.
    expect(body?.eventIndex).toBe(82);
    expect(body?.includesRawEvent).toBe(true);
    expect(body?.metadata.map((block) => block.label)).toEqual(["Working Directory"]);
  });

  it("leaves a person's own message alone when it lands right after a skill", () => {
    // `humanTurn` is the whole guard. Guessing from position alone would make a reader's message
    // vanish into a tool row, which is a worse failure than the one being fixed.
    const layout = buildFeedLayout(
      [
        skillCall,
        launching,
        {
          index: 82,
          ts: 3,
          type: "user",
          humanTurn: true,
          blocks: [{ kind: "text", text: "now use it on the panel" }, CWD, { kind: "raw" }],
        },
      ],
      NICE,
    );

    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([80, 82]);
    expect(layout.pairedToolResults.get("call-1")?.skillBody).toBeUndefined();
  });

  it("attaches nothing to an ordinary tool call the same text follows", () => {
    // Only a `Skill` call loads a body. A Read answered by a result, followed by an injected
    // `<system-reminder>`, must keep both rows.
    const layout = buildFeedLayout(
      [
        { index: 80, ts: 1, type: "assistant", blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }] },
        { index: 81, ts: 2, type: "user", blocks: [{ kind: "tool_result", preview: "file", callId: "call-1" }, CWD] },
        { index: 82, ts: 3, type: "user", blocks: [{ kind: "text", text: "<system-reminder>hi</system-reminder>" }] },
      ],
      NICE,
    );

    expect(layout.items.filter(isEventItem).map((item) => leadEvent(item).index)).toEqual([80, 82]);
    expect(layout.pairedToolResults.get("call-1")?.skillBody).toBeUndefined();
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

  it("keeps the compaction banner in the view people actually read the thread in", () => {
    // The bug this pins: Nice drops transcript scaffolding by event type, and a compaction is a
    // `system` line because it is not a turn. So the banner rendered only in Raw, and a session
    // that had just been compacted looked like one that simply carried on.
    const layout = buildFeedLayout(
      [
        {
          index: 50,
          ts: 1,
          type: "system",
          blocks: [{ kind: "metadata", label: "Mode", text: "default" }, { kind: "raw" }],
        },
        { index: 51, ts: 2, type: "system", blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }] },
      ],
      NICE,
    );

    expect(layout.items.map((item) => item.kind)).toEqual(["compaction"]);
    expect(leadEvent(layout.items[0]! as DisplayItem).index).toBe(51);
  });

  it("draws one banner for the two records a compaction is written as", () => {
    // Claude writes the `compact_boundary` and then a synthetic user message holding the summary
    // that replaced the context. Both normalize to a compaction block, and two banners in a row
    // would read as two compactions. The boundary is kept because it is the one carrying the
    // metadata and the occupancy the meter moves on, and it takes the summary the second carries.
    const layout = buildFeedLayout(
      [
        { index: 60, ts: 2, type: "system", blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }] },
        {
          index: 61,
          ts: 1,
          type: "system",
          blocks: [{ kind: "compaction", text: "Summary:\n1. Intent" }, CWD, { kind: "raw" }],
        },
        { index: 62, ts: 3, type: "assistant", blocks: [{ kind: "text", text: "after" }] },
      ],
      NICE,
    );

    expect(layout.items.map((item) => item.kind)).toEqual(["compaction", "segment_event"]);
    const banner = leadEvent(layout.items[0]! as DisplayItem);
    expect(banner.index).toBe(60);
    expect(banner.blocks[0]).toEqual({ kind: "compaction", text: "Summary:\n1. Intent" });
  });

  it("keeps a row per line in Raw, where fidelity is the point", () => {
    const layout = buildFeedLayout([
      { index: 70, ts: 2, type: "system", blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }] },
      { index: 71, ts: 1, type: "system", blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }] },
    ]);

    expect(layout.items.map((item) => item.kind)).toEqual(["compaction", "compaction"]);
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

describe("gaps between the ranges held", () => {
  // Transcript rows, named by byte position and joined by `previous`.
  const prose = (index: number, previous: number | null): ActivityEvent =>
    ({ index, previous, ts: index, type: "assistant", blocks: [{ kind: "text", text: `at ${index}` }] });
  const tool = (index: number, previous: number | null): ActivityEvent =>
    ({ index, previous, ts: index, type: "assistant", blocks: [{ kind: "tool_use", tool: "Bash", summary: "ls" }] });
  const system = (index: number, previous: number | null): ActivityEvent =>
    ({ index, previous, ts: index, type: "system", blocks: [{ kind: "metadata", label: "init", text: "x" }] });

  it("draws a gap row where a held row's previous row is not held, and ends the segment there", () => {
    const layout = buildFeedLayout([prose(0, null), prose(10, 0), prose(50, 40), prose(60, 50)]);

    expect(layout.items.map((item) => item.kind)).toEqual(["segment_event", "segment_event", "gap", "segment_event", "segment_event"]);
    expect(layout.items[2]).toEqual({ kind: "gap", above: 10, below: 50 });
    const [, before, , after] = layout.items as { isFirst?: boolean; isLast?: boolean }[];
    expect(before!.isLast).toBe(true);
    expect(after!.isFirst).toBe(true);
  });

  it("does not fold a run of tool calls across a gap", () => {
    const layout = buildFeedLayout(
      [tool(0, null), tool(10, 0), tool(50, 40), tool(60, 50)],
      { cluster: true, foldedClusters: new Set([0, 50]) },
    );
    expect(layout.items.map((item) => item.kind)).toEqual(["cluster", "gap", "cluster"]);
  });

  it("reads a row the view hides as joining its neighbours, not as a gap", () => {
    const layout = buildFeedLayout([prose(0, null), system(10, 0), prose(20, 10)], NICE);
    expect(layout.items.map((item) => item.kind)).toEqual(["segment_event", "segment_event"]);
  });
});
