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

describe("useSessionEventsStream", () => {
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
});
