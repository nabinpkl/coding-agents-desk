import { describe, expect, it } from "vitest";
import { queuedTails, retireLiveRows, splitLiveTails } from "@/features/activity-feed/rows/liveTailBlocks";
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

  it("drops the last block once its line landed, whether or not the mirror saw the message end", () => {
    expect(splitLiveTails([message("streaming", [firstThought])], [line(1, firstThought)]))
      .toEqual([]);
    expect(splitLiveTails([message("complete", [firstThought])], [line(1, firstThought)]))
      .toEqual([]);
  });

  it("drops a mirror that stopped short of a message the transcript finished", () => {
    const reply: ActivityBlock = { kind: "text", text: "The fourth review passed." };
    // The observer dropped after the thinking, so the mirror never heard the reply or the end.
    expect(splitLiveTails(
      [message("streaming", [firstThought])],
      [line(1, firstThought), line(2, reply)],
    )).toEqual([]);
  });

  it("keeps the blocks a streaming message has not had written yet", () => {
    const rows = splitLiveTails([message("streaming", [firstThought, listCall])], [line(1, firstThought)]);

    expect(rows.map((row) => row.blocks[0])).toEqual([listCall]);
    expect(rows[0]!.phase).toBe("streaming");
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

describe("retireLiveRows", () => {
  const reply: ActivityBlock = { kind: "text", text: "The fourth review passed." };
  const rows = (...events: ActivityEvent[]) => new Map(events.map((event) => [event.id!, event]));

  it("retires a streaming row once the file holds a line for every block it has", () => {
    // The observer dropped after the thinking: the mirror never heard the reply or the end.
    const stalled = message("streaming", [firstThought]);
    expect(retireLiveRows(rows(stalled), [line(1, firstThought), line(2, reply)]).size).toBe(0);
  });

  it("keeps a streaming row while the file is short of its blocks", () => {
    const streaming = message("streaming", [firstThought, listCall]);
    expect(retireLiveRows(rows(streaming), [line(1, firstThought)]).size).toBe(1);
  });

  it("retires the rows the mirror published before a row it retires", () => {
    const earlier: ActivityEvent = { ...message("complete", [listCall]), id: "claude-live:msg_0", index: 3, messageId: "msg_0" };
    const stalled = message("streaming", [firstThought]);
    expect(retireLiveRows(rows(earlier, stalled), [line(1, firstThought)]).size).toBe(0);
  });
});

describe("an SDK session's queued prompts", () => {
  const user = (text: string, ts: number): ActivityEvent => ({ index: ts, ts, type: "user", blocks: [{ kind: "text", text }] });
  const queued = [
    { id: "q1", text: "also this", images: 0, sentAt: 10_000 },
    { id: "q2", text: "and that", images: 0, sentAt: 11_000 },
  ];

  it("are rows after everything else, marked queued, keyed by their own id", () => {
    const tails = queuedTails(queued, []);
    expect(tails.map((tail) => [tail.id, tail.pending, tail.type, tail.blocks[0]])).toEqual([
      ["queued:q1", "queued", "user", { kind: "text", text: "also this" }],
      ["queued:q2", "queued", "user", { kind: "text", text: "and that" }],
    ]);
  });

  it("go the moment the transcript holds the same words, sent after them, and not before", () => {
    // An older message with the same words is not this one landing.
    expect(queuedTails(queued, [user("also this", 1_000)]).map((tail) => tail.id)).toEqual(["queued:q1", "queued:q2"]);
    expect(queuedTails(queued, [user(" also this ", 10_500)]).map((tail) => tail.id)).toEqual(["queued:q2"]);
    expect(queuedTails([], [user("x", 1)])).toEqual([]);
  });
});
