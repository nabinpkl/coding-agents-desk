// A reconnect after a stall longer than a window. The snapshot carries the newest window, the
// reader still holds what they had before the stall, and the rows written in between are in
// neither -- so they are fetched, rather than left as a hole that scrolling up never reaches,
// because paging only ever asks for rows below the oldest one held.

import { act, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { EventsPage } from "@/features/activity-feed/data-source/AgentDataSource";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { pageOf, renderThread, snapshotOf, thread } from "@/features/activity-feed/sessionEventsHarness";

function row(index: number, label = "row", revision = 0): ActivityEvent {
  return { index, id: `${label}-${index}`, revision, phase: "complete", ts: index, type: "assistant", blocks: [] };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => from + at);
const indices = (events: ActivityEvent[]) => events.map((event) => event.index);

/** A session of `rows` ordinal rows that grows when told, as a runtime projection's does. */
function growing(rows: number) {
  const session = { rows };
  const harness = thread(range(0, rows).map((index) => row(index)), { stableIndices: true });
  harness.answerWith(async (before, limit) => pageOf(range(0, session.rows).map((index) => row(index)), before, limit));
  const view = renderThread(harness.source);
  return {
    view,
    harness,
    /** The sidecar's reopened stream: its newest window, of a session that is now `rows` long. */
    reconnect: (next: number, sequence: number) => {
      session.rows = next;
      act(() => harness.handlers().onSnapshot(snapshotOf(range(next - 100, next).map((index) => row(index)), {
        sequence,
        windowStart: next - 100,
        stableIndices: true,
      })));
    },
  };
}

test("fetches the rows a reconnect skipped, newest page first", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));
  expect(session.view.result.current.windowStart).toBe(150);

  // 150 rows were written while the stream was stalled: 250..399 are in neither the rows held
  // nor the snapshot, which starts at 400.
  session.reconnect(500, 2);

  await waitFor(() => expect(indices(session.view.result.current.events)).toEqual(range(150, 500)));
  expect(session.harness.pages).toEqual([[400, 100], [300, 100]]);
  expect(session.view.result.current.windowStart).toBe(150);
});

test("asks for nothing when the reconnect left no hole", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));

  session.reconnect(300, 2);

  expect(indices(session.view.result.current.events)).toEqual(range(150, 300));
  await act(async () => {});
  expect(session.harness.pages).toEqual([]);
});

test("finds the hole by what each row says precedes it, not by adjacent numbers", async () => {
  // A transcript's rows are named by the byte their line starts at, so neighbours are far apart
  // numerically. Only `previous` says whether anything is missing between two of them.
  const at = (n: number) => n * 1000;
  const transcriptRow = (n: number): ActivityEvent => ({ ...row(at(n)), previous: n === 0 ? null : at(n - 1) });
  const all = range(0, 300).map(transcriptRow);
  const harness = thread(all.slice(0, 120), { stableIndices: true });
  harness.answerWith(async (before, limit) => pageOf(all, before, limit));
  const view = renderThread(harness.source);
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  // Held: rows 20..119. Nothing is missing between them although their indices are 1000 apart.
  await act(async () => {});
  expect(harness.pages).toEqual([]);

  act(() => harness.handlers().onSnapshot(snapshotOf(all.slice(200), {
    windowStart: at(200),
    stableIndices: true,
  })));

  await waitFor(() => expect(view.result.current.events).toHaveLength(280));
  expect(harness.pages).toEqual([[at(200), 100]]);
});

test("throws away a fill that a newer snapshot overtook, and fills again", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));

  let answerStale: (() => void) | undefined;
  session.harness.answerWith((before, limit) => new Promise<EventsPage>((resolve) => {
    // A newer revision, so only the epoch check can be what keeps it out.
    answerStale = () => resolve({
      events: range(before! - limit, before!).map((index) => row(index, "stale", 5)),
      windowStart: before! - limit,
      usage: null,
    });
  }));
  session.reconnect(400, 2);
  await waitFor(() => expect(answerStale).toBeDefined());
  const stale = answerStale!;

  // The stream reopens again before that page comes back, with the same hole.
  session.harness.answerWith(async (before, limit) => pageOf(range(0, 400).map((index) => row(index)), before, limit));
  session.reconnect(400, 3);
  await waitFor(() => expect(indices(session.view.result.current.events)).toEqual(range(150, 400)));

  await act(async () => stale());
  expect(session.view.result.current.events.some((event) => event.id?.startsWith("stale"))).toBe(false);
});
