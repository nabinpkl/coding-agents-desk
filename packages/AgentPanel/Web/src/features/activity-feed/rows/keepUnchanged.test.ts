import { describe, expect, it } from "vitest";
import { buildFeedLayout } from "@/features/activity-feed/rows/activityFeedLayout";
import { keepUnchangedItems, keepUnchangedPairs } from "@/features/activity-feed/rows/keepUnchanged";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

function prose(index: number, text: string): ActivityEvent {
  return { index, ts: 1, type: "assistant", blocks: [{ kind: "text", text }] };
}
function call(index: number, callId: string): ActivityEvent {
  return { index, ts: 1, type: "assistant", blocks: [{ kind: "tool_use", tool: "Bash", summary: "ls", callId }] };
}
function result(index: number, callId: string, preview: string): ActivityEvent {
  return { index, ts: 1, type: "user", blocks: [{ kind: "tool_result", preview, callId }] };
}

const RAW = { cluster: false, hideSystem: false } as const;

describe("a rebuilt layout keeps what a new line did not change", () => {
  it("hands back the previous item for every row the line left alone", () => {
    const events = [prose(0, "first"), prose(1, "second")];
    const before = buildFeedLayout(events, RAW).items;
    const after = keepUnchangedItems(before, buildFeedLayout([...events, prose(2, "third")], RAW).items);

    expect(after).toHaveLength(3);
    // The three share one segment: the first row's place in it did not move, while the old last
    // row is no longer last and has to draw its join to the row below.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("takes the new item where the row's event changed or its place in the segment did", () => {
    const first = prose(0, "first");
    const before = buildFeedLayout([first, prose(1, "draft")], { cluster: true, hideSystem: true }).items;
    const rebuilt = buildFeedLayout([first, prose(1, "final"), prose(2, "more")], { cluster: true, hideSystem: true }).items;
    const after = keepUnchangedItems(before, rebuilt);

    expect(after[1]).toBe(rebuilt[1]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("treats an event rebuilt around the same blocks as unchanged", () => {
    const original = prose(0, "same");
    const before = buildFeedLayout([original], RAW).items;
    const copy: ActivityEvent = { ...original, blocks: [...original.blocks] };
    const after = keepUnchangedItems(before, buildFeedLayout([copy], RAW).items);

    expect(after[0]).toBe(before[0]);
  });

  it("keeps a paired result whose content is the same, and replaces one that is new", () => {
    const answered = [call(0, "a"), result(1, "a", "done"), call(2, "b")];
    const before = buildFeedLayout(answered, RAW).pairedToolResults;
    const after = keepUnchangedPairs(
      before,
      buildFeedLayout([...answered, result(3, "b", "also done")], RAW).pairedToolResults,
    );

    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")?.eventIndex).toBe(3);
    expect(before.has("b")).toBe(false);
  });
});
