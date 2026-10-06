// A thread holds ranges of its transcript with gaps between them (ADR-0125). A reconnect after a
// stall longer than a window leaves one; a range opened around a row the reader jumped to leaves
// two. The hook holds the rows and reads pages into a gap from either side; which gap is filled,
// and when, is the feed's (`useGapFill`).

import { act, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { EventsPage } from "@/features/activity-feed/data-source/AgentDataSource";
import { gapsIn } from "@/features/activity-feed/data-source/eventPaging";
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
  harness.answerWith(async (at, limit) => pageOf(range(0, session.rows).map((index) => row(index)), at, limit));
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

test("a reconnect that outran a window keeps both ranges and asks for nothing by itself", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));
  expect(session.view.result.current.windowStart).toBe(150);

  // 150 rows were written while the stream was stalled: 250..399 are in neither range.
  session.reconnect(500, 2);

  const events = session.view.result.current.events;
  expect(indices(events)).toEqual([...range(150, 250), ...range(400, 500)]);
  expect(gapsIn(events)).toEqual([{ above: 249, below: 400 }]);
  // The oldest range still starts where it did.
  expect(session.view.result.current.windowStart).toBe(150);
  await act(async () => {});
  expect(session.harness.pages).toEqual([]);
});

test("a gap filled from below grows the range under it, and from above the range over it", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));
  session.reconnect(500, 2);

  await act(() => session.view.result.current.fillGap({ above: 249, below: 400 }, "below"));
  expect(session.harness.pages.at(-1)).toEqual([{ before: 400 }, 100]);
  expect(gapsIn(session.view.result.current.events)).toEqual([{ above: 249, below: 300 }]);

  await act(() => session.view.result.current.fillGap({ above: 249, below: 300 }, "above"));
  expect(session.harness.pages.at(-1)).toEqual([{ after: 249 }, 100]);
  expect(indices(session.view.result.current.events)).toEqual(range(150, 500));
});

test("finds a gap by what each row says precedes it, not by adjacent numbers", async () => {
  // A transcript's rows are named by the byte their line starts at, so neighbours are far apart
  // numerically. Only `previous` says whether anything is missing between two of them.
  const at = (n: number) => n * 1000;
  const transcriptRow = (n: number): ActivityEvent => ({ ...row(at(n)), previous: n === 0 ? null : at(n - 1) });
  const all = range(0, 300).map(transcriptRow);
  const harness = thread(all.slice(0, 120), { stableIndices: true });
  harness.answerWith(async (where, limit) => pageOf(all, where, limit));
  const view = renderThread(harness.source);
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  // Held: rows 20..119. Nothing is missing between them although their indices are 1000 apart.
  expect(gapsIn(view.result.current.events)).toEqual([]);

  act(() => harness.handlers().onSnapshot(snapshotOf(all.slice(200), {
    windowStart: at(200),
    stableIndices: true,
  })));

  expect(gapsIn(view.result.current.events)).toEqual([{ above: at(119), below: at(200) }]);
});

test("opens a range around a row it does not hold, in one read", async () => {
  const session = growing(1000);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));

  await act(() => session.view.result.current.loadAround(300));

  expect(session.harness.pages).toEqual([[{ around: 300 }, 100]]);
  const events = session.view.result.current.events;
  expect(indices(events)).toEqual([...range(250, 350), ...range(900, 1000)]);
  expect(gapsIn(events)).toEqual([{ above: 349, below: 900 }]);
  // The range opened is now the oldest, so older paging continues from its start.
  expect(session.view.result.current.windowStart).toBe(250);
});

test("throws away a page that a newer snapshot overtook", async () => {
  const session = growing(250);
  await waitFor(() => expect(session.view.result.current.loading).toBe(false));
  session.reconnect(400, 2);

  let answerStale: (() => void) | undefined;
  session.harness.answerWith((where, limit) => new Promise<EventsPage>((resolve) => {
    const before = "before" in where ? where.before! : 0;
    // A newer revision, so only the epoch check can be what keeps it out.
    answerStale = () => resolve({
      events: range(before - limit, before).map((index) => row(index, "stale", 5)),
      windowStart: before - limit,
      usage: null,
    });
  }));
  const filling = session.view.result.current.fillGap({ above: 249, below: 300 }, "below");
  await waitFor(() => expect(answerStale).toBeDefined());

  session.reconnect(400, 3);
  await act(async () => {
    answerStale!();
    await filling;
  });
  expect(session.view.result.current.events.some((event) => event.id?.startsWith("stale"))).toBe(false);
});
