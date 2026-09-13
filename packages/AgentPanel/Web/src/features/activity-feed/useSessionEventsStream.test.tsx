import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type {
  AgentDataSource,
  EventsPage,
  SessionEventsHandlers,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import {
  useSessionEventsStream,
  type ActivityEvent,
} from "@/features/activity-feed/useSessionEventsStream";

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
    const source: AgentDataSource = stubDataSource({
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
    });
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

  it("keeps paged-in history when a reconnect snapshot has stable indices", async () => {
    const all = Array.from({ length: 250 }, (_, index) =>
      event(index, `row-${index}`, "assistant"),
    );
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async (_session, offset, limit) => ({
        events: all.filter(
          (value) => value.index >= offset && value.index < offset + limit,
        ),
        total: all.length,
        usage: null,
      }),
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
    expect(view.result.current.windowStart).toBe(150);

    // The reader scrolls up, so a window of older rows is paged in below the
    // opening one.
    await act(async () => { await view.result.current.loadOlder(); });
    expect(view.result.current.windowStart).toBe(50);
    expect(view.result.current.events).toHaveLength(200);

    // The stream blips and EventSource reopens it. The sidecar answers every
    // open with the same opening window: the tail, and nothing below it.
    act(() => handlers?.onSnapshot?.({
      events: all.slice(150),
      total: all.length,
      windowStart: 150,
      stableIndices: true,
      usage: null,
      state: { sequence: 2, runState: "idle", queue: { steer: 0, followUp: 0 } },
    }));

    // The rows the reader paged in survive it, and the window still reaches
    // down to them so scrolling further up still has somewhere to go.
    expect(view.result.current.events).toHaveLength(200);
    expect(view.result.current.events[0]?.id).toBe("row-50");
    expect(view.result.current.windowStart).toBe(50);
    expect(view.result.current.total).toBe(250);
    expect(view.result.current.sequence).toBe(2);
  });

  it("still replaces the window when a snapshot does not claim stable indices", async () => {
    // The same session and the same reconnect, with the flag absent. This is
    // the runtime-backed contract, asserted here so the branch cannot be
    // simplified into an unconditional merge.
    const all = Array.from({ length: 250 }, (_, index) =>
      event(index, `row-${index}`, "assistant"),
    );
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async (_session, offset, limit) => ({
        events: all.filter(
          (value) => value.index >= offset && value.index < offset + limit,
        ),
        total: all.length,
        usage: null,
      }),
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
    await act(async () => { await view.result.current.loadOlder(); });
    expect(view.result.current.events).toHaveLength(200);

    act(() => handlers?.onSnapshot?.({
      events: all.slice(150),
      total: all.length,
      windowStart: 150,
      usage: null,
      state: { sequence: 2, runState: "idle", queue: { steer: 0, followUp: 0 } },
    }));

    expect(view.result.current.events).toHaveLength(100);
    expect(view.result.current.events[0]?.id).toBe("row-150");
    expect(view.result.current.windowStart).toBe(150);
  });

  it("does not let an in-flight initial page overwrite a reconnect snapshot", async () => {
    let handlers: SessionEventsHandlers | undefined;
    let resolveProbe: ((page: EventsPage) => void) | undefined;
    const probe = new Promise<EventsPage>((resolve) => { resolveProbe = resolve; });
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async () => probe,
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
    const source: AgentDataSource = stubDataSource({
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
    });
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

  it("initializes usage from the last transcript reading when the seed carries none", async () => {
    let handlers: SessionEventsHandlers | undefined;
    const seedEvents: ActivityEvent[] = [
      {
        index: 0,
        id: "user-0",
        revision: 0,
        phase: "complete",
        ts: 1000,
        type: "user",
        blocks: [{ kind: "text", text: "prompt" }],
      },
      {
        index: 1,
        id: "assistant-1",
        revision: 0,
        phase: "complete",
        ts: 2000,
        type: "assistant",
        blocks: [
          { kind: "text", text: "answer" },
          { kind: "metadata", label: "Token Usage", text: "71,411 tokens" },
        ],
      },
    ];
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async (_session, offset, limit) => ({
        events: seedEvents.filter(
          (value) => value.index >= offset && value.index < offset + limit,
        ),
        total: 2,
        usage: null,
      }),
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

    // No structured occupancy arrived with the seed, so the meter's initial
    // value must come from the transcript's own last reading.
    expect(view.result.current.usage).toEqual({
      current: 71_411,
      limit: null,
      updatedAt: 2000,
    });

    // A live reading with a newer timestamp replaces the fallback, exactly as
    // it replaces a structured reading today.
    act(() =>
      handlers?.onUsage?.({
        current: 88_000,
        limit: 200_000,
        updatedAt: 3000,
      }),
    );
    expect(view.result.current.usage).toEqual({
      current: 88_000,
      limit: 200_000,
      updatedAt: 3000,
    });
  });
});
