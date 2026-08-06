import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type {
  AgentDataSource,
  EventsPage,
  SessionEventsHandlers,
} from "./data-source/AgentDataSource";
import {
  useSessionEventsStream,
  type ActivityEvent,
} from "./useSessionEventsStream";

function event(
  index: number,
  id: string,
  type: ActivityEvent["type"],
): ActivityEvent {
  return { index, id, revision: 0, phase: "complete", ts: index, type, blocks: [] };
}

function tailEvent(index: number, messageId: string): ActivityEvent {
  return {
    index,
    id: `claude-live:${messageId}`,
    revision: 1,
    phase: "streaming",
    ts: index,
    type: "assistant",
    messageId,
    blocks: [{ kind: "text", text: "hello" }],
  };
}

describe("useSessionEventsStream", () => {
  it("shows a live tail and hands it off when the durable transcript has it", async () => {
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = {
      fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    };
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

    // A later tail event can start the next streaming block.
    act(() => handlers?.onLiveTail?.(tailEvent(5, "msg_2")));
    expect(view.result.current.liveTail?.messageId).toBe("msg_2");
  });

  it("replaces stale rows when a reconnect snapshot resets the runtime index", async () => {
    const initial = [
      event(0, "notice-0", "system"),
      event(1, "stale-tail", "assistant"),
    ];
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = {
      fetchEventsPage: async (_session, offset, limit) => ({
        events: initial.filter(
          (value) => value.index >= offset && value.index < offset + limit,
        ),
        total: initial.length,
        usage: null,
      }),
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DataSourceProvider source={source}>{children}</DataSourceProvider>
    );
    const view = renderHook(
      () => useSessionEventsStream("pi", "thread", "nice"),
      { wrapper },
    );

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "notice-0",
      "stale-tail",
    ]);

    act(() => handlers?.onSnapshot?.({
      events: [event(0, "fresh-message", "assistant")],
      total: 1,
      windowStart: 0,
      usage: null,
      state: {
        sequence: 1,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      },
    }));

    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "fresh-message",
    ]);
    expect(view.result.current.total).toBe(1);
    expect(view.result.current.sequence).toBe(1);
  });

  it("does not let an in-flight initial page overwrite a reconnect snapshot", async () => {
    let handlers: SessionEventsHandlers | undefined;
    let resolveProbe: ((page: EventsPage) => void) | undefined;
    const probe = new Promise<EventsPage>((resolve) => { resolveProbe = resolve; });
    const source: AgentDataSource = {
      fetchEventsPage: async () => probe,
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DataSourceProvider source={source}>{children}</DataSourceProvider>
    );
    const view = renderHook(
      () => useSessionEventsStream("pi", "thread", "nice"),
      { wrapper },
    );

    act(() => handlers?.onSnapshot({
      events: [event(0, "fresh-message", "assistant")],
      total: 1,
      windowStart: 0,
      usage: null,
      state: {
        sequence: 1,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      },
    }));
    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "fresh-message",
    ]);

    await act(async () => resolveProbe?.({
      events: [event(0, "stale-page", "system")],
      total: 1,
      usage: null,
    }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "fresh-message",
    ]);
  });

  it("does not merge an older page that resolves after a replacement snapshot", async () => {
    let handlers: SessionEventsHandlers | undefined;
    let resolveOlder: ((page: EventsPage) => void) | undefined;
    let fetchCount = 0;
    const source: AgentDataSource = {
      fetchEventsPage: async () => {
        fetchCount += 1;
        if (fetchCount === 1) return { events: [], total: 101, usage: null };
        if (fetchCount === 2) {
          return { events: [event(100, "current-tail", "assistant")], total: 101, usage: null };
        }
        return new Promise<EventsPage>((resolve) => { resolveOlder = resolve; });
      },
      subscribeSessionEvents: (_session, _after, nextHandlers) => {
        handlers = nextHandlers;
        return () => {};
      },
      fetchRawEvent: async () => "",
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DataSourceProvider source={source}>{children}</DataSourceProvider>
    );
    const view = renderHook(
      () => useSessionEventsStream("pi", "thread", "nice"),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    act(() => { void view.result.current.loadOlder(); });
    await waitFor(() => expect(resolveOlder).toBeDefined());
    act(() => handlers?.onSnapshot({
      events: [event(0, "fresh-message", "assistant")],
      total: 1,
      windowStart: 0,
      usage: null,
      state: {
        sequence: 1,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      },
    }));
    await act(async () => resolveOlder?.({
      events: [event(0, "stale-older-page", "system")],
      total: 101,
      usage: null,
    }));

    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "fresh-message",
    ]);
    expect(view.result.current.total).toBe(1);
    expect(view.result.current.windowStart).toBe(0);
  });
});
