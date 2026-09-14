// A reconnect after a stall longer than a window. The snapshot carries the newest window, the
// reader still holds what they had before the stall, and the rows written in between are in
// neither -- so they are fetched, rather than left as a hole that scrolling up never reaches,
// because paging only ever asks for rows below the oldest one held.

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
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

function row(index: number, label = "row", revision = 0): ActivityEvent {
  return { index, id: `${label}-${index}`, revision, phase: "complete", ts: index, type: "assistant", blocks: [] };
}

/** A transcript of `rows` rows that grows when told, and records every page asked of it. */
function transcript(rows: number) {
  const session = { rows, handlers: undefined as SessionEventsHandlers | undefined };
  const pages: Array<[number, number]> = [];
  let answer: (offset: number, limit: number) => Promise<EventsPage> = async (offset, limit) => ({
    events: Array.from({ length: Math.max(0, Math.min(limit, session.rows - offset)) }, (_, at) => row(offset + at)),
    total: session.rows,
    usage: null,
  });
  const source: AgentDataSource = stubDataSource({
    fetchEventsPage: (_session, offset, limit) => {
      pages.push([offset, limit]);
      return answer(offset, limit);
    },
    subscribeSessionEvents: (_session, _after, handlers) => {
      session.handlers = handlers;
      return () => {};
    },
    fetchRawEvent: async () => "",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataSourceProvider source={source}>{children}</DataSourceProvider>
  );
  const view = renderHook(() => useSessionEventsStream("claude", "thread", "nice"), { wrapper });
  return {
    view,
    pages,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
    /** The sidecar's reopened stream: its newest window, of a transcript that is now `rows` long. */
    reconnect: (rows: number, sequence: number) => {
      session.rows = rows;
      act(() => session.handlers?.onSnapshot({
        events: Array.from({ length: 100 }, (_, at) => row(rows - 100 + at)),
        total: rows,
        windowStart: rows - 100,
        stableIndices: true,
        usage: null,
        state: { sequence, runState: "running", queue: { steer: 0, followUp: 0 } },
      }));
    },
  };
}

const indices = (events: ActivityEvent[]) => events.map((event) => event.index);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => from + at);

test("fetches the rows a reconnect skipped, newest page first", async () => {
  const thread = transcript(250);
  await waitFor(() => expect(thread.view.result.current.loading).toBe(false));
  expect(thread.view.result.current.windowStart).toBe(150);
  const seedPages = thread.pages.length;

  // 150 rows were written while the stream was stalled: 250..399 are in neither the rows held
  // nor the snapshot, which starts at 400.
  thread.reconnect(500, 2);

  await waitFor(() => expect(indices(thread.view.result.current.events)).toEqual(range(150, 500)));
  expect(thread.pages.slice(seedPages)).toEqual([[300, 100], [250, 50]]);
  expect(thread.view.result.current.windowStart).toBe(150);
});

test("asks for nothing when the reconnect left no hole", async () => {
  const thread = transcript(250);
  await waitFor(() => expect(thread.view.result.current.loading).toBe(false));
  const seedPages = thread.pages.length;

  thread.reconnect(300, 2);

  expect(indices(thread.view.result.current.events)).toEqual(range(150, 300));
  await act(async () => {});
  expect(thread.pages.slice(seedPages)).toEqual([]);
});

test("throws away a fill that a newer snapshot overtook, and fills again", async () => {
  const thread = transcript(250);
  await waitFor(() => expect(thread.view.result.current.loading).toBe(false));

  let answerStale: (() => void) | undefined;
  thread.answerWith((offset, limit) => new Promise((resolve) => {
    // A newer revision, so only the epoch check can be what keeps it out.
    answerStale = () => resolve({
      events: range(offset, offset + limit).map((index) => row(index, "stale", 5)),
      total: 400,
      usage: null,
    });
  }));
  thread.reconnect(400, 2);
  await waitFor(() => expect(answerStale).toBeDefined());
  const stale = answerStale!;

  // The stream reopens again before that page comes back, with the same hole.
  thread.answerWith(async (offset, limit) => ({
    events: range(offset, offset + limit).map((index) => row(index)),
    total: 400,
    usage: null,
  }));
  thread.reconnect(400, 3);
  await waitFor(() => expect(indices(thread.view.result.current.events)).toEqual(range(150, 400)));

  await act(async () => stale());
  expect(thread.view.result.current.events.some((event) => event.id?.startsWith("stale"))).toBe(false);
});
