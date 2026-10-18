import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { renderThread, thread } from "@/features/activity-feed/sessionEventsHarness";

/**
 * `ts` is the moment the message began streaming, which is what the mirror stamps
 * and what decides whether a tail is still ahead of the transcript. It is passed
 * rather than derived from the index so a test can place a tail before or after the
 * file's own rows on purpose.
 */
function tailEvent(index: number, messageId: string, ts = index): ActivityEvent {
  return {
    index,
    id: `claude-live:${messageId}`,
    revision: 1,
    phase: "streaming",
    ts,
    type: "assistant",
    messageId,
    blocks: [{ kind: "text", text: "hello" }],
  };
}

describe("useSessionEventsStream live tail", () => {
  it("shows a live tail and hands it off when the durable transcript has it", async () => {
    const session = thread([]);
    const view = renderThread(session.source, "claude", "nice");
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const handlers = session.handlers();

    // A streaming live message becomes the tail: prose, then a call still being written.
    const call = { kind: "tool_use", tool: "Bash", summary: "ls", callId: "c1" } as const;
    const streaming = { ...tailEvent(0, "msg_1"), blocks: [{ kind: "text", text: "hello" } as const, call] };
    act(() => handlers?.onLiveTail?.(streaming));
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_1", "msg_1"]);
    expect(view.result.current.liveTails.at(-1)?.phase).toBe("streaming");

    // The file's line for the prose arrives while the mirror still calls the message
    // streaming. It takes over the prose only, and the call stays previewed below it.
    act(() =>
      handlers?.onEvent({
        index: 4,
        id: "row-1",
        revision: 0,
        phase: "complete",
        ts: 5,
        type: "assistant",
        messageId: "msg_1",
        blocks: [{ kind: "text", text: "hello" }],
      }),
    );
    expect(view.result.current.liveTails.map((row) => row.blocks)).toEqual([[call]]);

    // The live message finishes; the durable transcript now contains it
    // (same id, complete): the tail is handed off and dropped.
    act(() => handlers?.onLiveTail?.({ ...streaming, phase: "complete" }));
    act(() =>
      handlers?.onEvent({
        index: 4,
        id: "row-1",
        revision: 0,
        phase: "complete",
        ts: 6,
        type: "assistant",
        messageId: "msg_1",
        blocks: [{ kind: "text", text: "hello" }],
      }),
    );
    expect(view.result.current.events.map((value) => value.messageId)).toContain("msg_1");
    expect(view.result.current.liveTails).toEqual([]);

    // A later tail event can start the next streaming block. It began after the row
    // above was written, which is what makes it the part of the turn the file has
    // not reached.
    act(() => handlers?.onLiveTail?.(tailEvent(5, "msg_2", 7)));
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_2"]);
  });

  it("drops a tail the transcript has passed, even when its message never lands", async () => {
    // A mirror that stops mid-turn keeps publishing the last row it saw, and that row's
    // message is never written to the file, so the handoff on `messageId` can never fire.
    // Measured against a live session: a finished message from three hours earlier sat
    // below the thread as a 9,554px block while the transcript streamed correctly above
    // it, and a feed that follows its own bottom showed nothing but the block.
    const session = thread([]);
    const view = renderThread(session.source, "claude", "nice");
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const handlers = session.handlers();

    act(() => handlers?.onLiveTail?.(tailEvent(0, "orphan", 100)));
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["orphan"]);

    // The turn's own tool result carries no message, so it says nothing about which
    // message the file has reached and must not retire the tail on its own.
    act(() =>
      handlers?.onEvent({
        index: 1,
        id: "result-1",
        revision: 0,
        phase: "complete",
        ts: 150,
        type: "user",
        blocks: [{ kind: "tool_result", text: "ok" }],
      }),
    );
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["orphan"]);

    // A different message reaches the file, from after the tail began. The transcript
    // has moved past it, so the preview has nothing left to add.
    act(() =>
      handlers?.onEvent({
        index: 2,
        id: "row-later",
        revision: 0,
        phase: "complete",
        ts: 200,
        type: "assistant",
        messageId: "msg_later",
        blocks: [{ kind: "text", text: "written" }],
      }),
    );
    expect(view.result.current.liveTails).toEqual([]);
    expect(view.result.current.events.map((value) => value.id)).toEqual(["result-1", "row-later"]);
  });

  it("keeps the whole turn previewed while the transcript is behind", async () => {
    // The mirror opens a row per message and moves on. Measured 2026-09-10, the
    // durable stream delivered nothing for ninety seconds while four messages went
    // through, so a single slot showed one of them and lost the other three.
    const session = thread([]);
    const view = renderThread(session.source, "claude", "nice");
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const handlers = session.handlers();

    // Three messages stream, one after another, with nothing durable arriving. Each
    // finishes before the next starts, exactly as the mirror publishes them.
    act(() => handlers?.onLiveTail?.(tailEvent(0, "msg_a", 100)));
    act(() => handlers?.onLiveTail?.({ ...tailEvent(0, "msg_a", 100), phase: "complete" }));
    act(() => handlers?.onLiveTail?.(tailEvent(1, "msg_b", 200)));
    act(() => handlers?.onLiveTail?.({ ...tailEvent(1, "msg_b", 200), phase: "complete" }));
    act(() => handlers?.onLiveTail?.(tailEvent(2, "msg_c", 300)));
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_a", "msg_b", "msg_c"]);

    // The file finally catches up on the FIRST of them. Its row is stamped when the
    // message was written, which is after the next one began streaming -- so a rule
    // that read that stamp as "the file has moved past the preview" would retire the
    // rest of the turn on the strength of the row that proves the opposite.
    act(() =>
      handlers?.onEvent({
        index: 0,
        id: "row-a",
        revision: 0,
        phase: "complete",
        ts: 250,
        type: "assistant",
        messageId: "msg_a",
        blocks: [{ kind: "text", text: "a" }],
      }),
    );
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_b", "msg_c"]);

    // Reaching a later message retires everything the mirror published before it,
    // whether or not the panel's window still holds those rows.
    act(() =>
      handlers?.onEvent({
        index: 1,
        id: "row-b",
        revision: 0,
        phase: "complete",
        ts: 350,
        type: "assistant",
        messageId: "msg_b",
        blocks: [{ kind: "text", text: "b" }],
      }),
    );
    expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_c"]);
  });

  // Either side can be the late one, and the handoff used to run only when the file's row arrived.
  describe("whichever side lands last", () => {
    const line = (index: number, messageId: string): ActivityEvent => ({
      index,
      id: `row-${index}`,
      revision: 0,
      phase: "complete",
      ts: index,
      type: "assistant",
      messageId,
      blocks: [{ kind: "text", text: "Done." }],
    });
    /** The mirror's row for a follow-up request's tool results: no message, one result per call. */
    const results = (index: number, ...callIds: string[]): ActivityEvent => ({
      index,
      id: `claude-live:user:flow-${index}`,
      revision: 0,
      phase: "complete",
      ts: index,
      type: "user",
      blocks: callIds.map((callId) => ({ kind: "tool_result", callId, preview: "contents" })),
    });

    it("retires a message that finishes after its line landed, and the results before it", async () => {
      const session = thread([]);
      const view = renderThread(session.source, "claude", "nice");
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      const handlers = session.handlers();

      // Prose and a call, so the prose's line alone does not cover the message.
      const call = { kind: "tool_use", tool: "Bash", summary: "ls", callId: "c1" } as const;
      const done = { ...tailEvent(1, "msg_done", 1), blocks: [{ kind: "text", text: "hello" } as const, call] };
      act(() => handlers.onLiveTail?.(results(0, "call-a")));
      act(() => handlers.onLiveTail?.(done));
      act(() => handlers.onEvent(line(9, "msg_done")));
      expect(view.result.current.liveTails.length).toBeGreaterThan(0);

      act(() => handlers.onLiveTail?.({ ...done, phase: "complete" }));
      expect(view.result.current.liveTails).toEqual([]);
    });

    it("retires a tail replayed after the snapshot already carried its message", async () => {
      const session = thread([line(9, "msg_done")]);
      const view = renderThread(session.source, "claude", "nice");
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      const handlers = session.handlers();

      // A stream opened after the turn ended replays the mirror's rows behind its snapshot.
      act(() => handlers.onLiveTail?.(results(0, "call-a")));
      act(() => handlers.onLiveTail?.({ ...tailEvent(1, "msg_done", 1), phase: "complete" }));
      expect(view.result.current.liveTails).toEqual([]);
    });

    it("retires a stalled row replayed after the snapshot holds every block of it", async () => {
      const session = thread([line(9, "msg_done")]);
      const view = renderThread(session.source, "claude", "nice");
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      const handlers = session.handlers();

      // The mirror lost this message's end, so it still calls it streaming.
      act(() => handlers.onLiveTail?.(tailEvent(1, "msg_done", 1)));
      expect(view.result.current.liveTails).toEqual([]);
    });

    it("drops a results row once the file pairs every result in it", async () => {
      const session = thread([]);
      const view = renderThread(session.source, "claude", "nice");
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      const handlers = session.handlers();
      const paired = (index: number, callId: string): ActivityEvent => ({
        ...results(index, callId),
        id: `row-${index}`,
      });

      act(() => handlers.onLiveTail?.(results(0, "call-a", "call-b")));
      act(() => handlers.onLiveTail?.(tailEvent(1, "msg_next", 1)));
      act(() => handlers.onEvent(paired(8, "call-a")));
      // Half of it is still only in the mirror.
      expect(view.result.current.liveTails.map((row) => row.type)).toEqual(["user", "assistant"]);

      act(() => handlers.onEvent(paired(9, "call-b")));
      expect(view.result.current.liveTails.map((row) => row.messageId)).toEqual(["msg_next"]);
    });
  });
});
