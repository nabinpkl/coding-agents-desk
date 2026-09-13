import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type {
  AgentDataSource,
  SessionEventsHandlers,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import {
  useSessionEventsStream,
  type ActivityEvent,
} from "@/features/activity-feed/useSessionEventsStream";

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
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DataSourceProvider source={source}>{children}</DataSourceProvider>
    );
    const view = renderHook(
      () => useSessionEventsStream("claude", "thread", "nice"),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    // A streaming live message becomes the tail.
    act(() => handlers?.onLiveTail?.(tailEvent(0, "msg_1")));
    expect(view.result.current.liveTail?.messageId).toBe("msg_1");
    expect(view.result.current.liveTail?.phase).toBe("streaming");

    // A durable row for the same message arrives WHILE it is still streaming
    // (transcripts append per tool step). It must NOT clear the tail early.
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
    expect(view.result.current.liveTail).not.toBeNull();

    // The live message finishes; the durable transcript now contains it
    // (same id, complete): the tail is handed off and dropped.
    act(() => handlers?.onLiveTail?.({ ...tailEvent(0, "msg_1"), phase: "complete" }));
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
    expect(view.result.current.liveTail).toBeNull();

    // A later tail event can start the next streaming block. It began after the row
    // above was written, which is what makes it the part of the turn the file has
    // not reached.
    act(() => handlers?.onLiveTail?.(tailEvent(5, "msg_2", 7)));
    expect(view.result.current.liveTail?.messageId).toBe("msg_2");
  });

  it("drops a tail the transcript has passed, even when its message never lands", async () => {
    // A mirror that stops mid-turn keeps publishing the last row it saw, and that row's
    // message is never written to the file, so the handoff on `messageId` can never fire.
    // Measured against a live session: a finished message from three hours earlier sat
    // below the thread as a 9,554px block while the transcript streamed correctly above
    // it, and a feed that follows its own bottom showed nothing but the block.
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DataSourceProvider source={source}>{children}</DataSourceProvider>
    );
    const view = renderHook(
      () => useSessionEventsStream("claude", "thread", "nice"),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    act(() => handlers?.onLiveTail?.(tailEvent(0, "orphan", 100)));
    expect(view.result.current.liveTail?.messageId).toBe("orphan");

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
    expect(view.result.current.liveTail?.messageId).toBe("orphan");

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
    expect(view.result.current.liveTail).toBeNull();
    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "result-1",
      "row-later",
    ]);
  });
});
