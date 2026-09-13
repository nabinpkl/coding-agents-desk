import { describe, expect, it } from "vitest";
import { splitLiveTails } from "@/features/activity-feed/rows/liveTailBlocks";
import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

function message(phase: ActivityEvent["phase"], blocks: ActivityBlock[]): ActivityEvent {
  return {
    id: "claude-live:msg_1",
    index: 7,
    revision: 3,
    phase,
    ts: 100,
    type: "assistant",
    messageId: "msg_1",
    blocks,
  };
}

/** One transcript line for a block of `msg_1`, the way Claude writes a message. */
function line(index: number, block: ActivityBlock, messageId = "msg_1"): ActivityEvent {
  return {
    id: `claude:line:${index}`,
    index,
    revision: 0,
    phase: "complete",
    ts: 200 + index,
    type: block.kind === "reasoning" ? "reasoning" : "assistant",
    messageId,
    blocks: [block],
  };
}

const firstThought: ActivityBlock = { kind: "reasoning", text: "first thought" };
const secondThought: ActivityBlock = { kind: "reasoning", text: "second thought" };
const listCall: ActivityBlock = { kind: "tool_use", tool: "Bash", summary: "ls", callId: "a" };
const statusCall: ActivityBlock = { kind: "tool_use", tool: "Bash", summary: "git status", callId: "b" };

describe("splitLiveTails", () => {
  it("gives each block of a streaming message the row the transcript will give it", () => {
    const rows = splitLiveTails(
      [message("streaming", [firstThought, secondThought, listCall, statusCall])],
      [],
    );

    expect(rows.map((row) => [row.type, row.blocks.map((block) => block.kind)])).toEqual([
      ["reasoning", ["reasoning"]],
      ["reasoning", ["reasoning"]],
      ["assistant", ["tool_use"]],
      ["assistant", ["tool_use"]],
    ]);
    expect(rows.map((row) => row.phase)).toEqual(["complete", "complete", "complete", "streaming"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
  });

  it("drops the blocks the transcript already wrote, which were showing twice", () => {
    const rows = splitLiveTails(
      [message("streaming", [firstThought, secondThought, listCall, statusCall])],
      [line(661, firstThought), line(662, secondThought)],
    );

    expect(rows.map((row) => row.blocks[0])).toEqual([listCall, statusCall]);
    // Named by block index, so the drop does not rename a row the reader collapsed.
    expect(rows.map((row) => row.id)).toEqual(["claude-live:msg_1:2", "claude-live:msg_1:3"]);
  });

  it("keeps the last block of a streaming message even once its line landed", () => {
    expect(splitLiveTails([message("streaming", [firstThought])], [line(1, firstThought)]))
      .toHaveLength(1);
    expect(splitLiveTails([message("complete", [firstThought])], [line(1, firstThought)]))
      .toEqual([]);
  });

  it("counts only the lines of the message itself", () => {
    const rows = splitLiveTails(
      [message("streaming", [firstThought, listCall])],
      [line(1, firstThought, "msg_0")],
    );

    expect(rows).toHaveLength(2);
  });

  it("keeps a trailing error on the message's last row", () => {
    const error: ActivityBlock = { kind: "metadata", label: "Agent error", text: "stream ended" };
    const rows = splitLiveTails([message("complete", [firstThought, error])], []);

    expect(rows.map((row) => row.blocks)).toEqual([[firstThought, error]]);
  });
});
