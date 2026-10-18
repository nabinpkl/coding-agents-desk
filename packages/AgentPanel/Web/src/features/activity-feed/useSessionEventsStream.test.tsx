import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventsPage } from "@/features/activity-feed/data-source/AgentDataSource";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { event, renderThread, snapshotOf, thread } from "@/features/activity-feed/sessionEventsHarness";

function rows(count: number): ActivityEvent[] {
  return Array.from({ length: count }, (_, index) => event(index, `row-${index}`, "assistant"));
}

describe("useSessionEventsStream", () => {
  it("opens on the stream's own snapshot and asks for no page to do it", async () => {
    // The opening window used to be two requests ahead of the stream -- a probe for the row count,
    // then the page it placed -- and the count cost the sidecar the whole transcript.
    const session = thread(rows(250));
    const view = renderThread(session.source);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events).toHaveLength(100);
    expect(view.result.current.events[0]?.id).toBe("row-150");
    expect(view.result.current.windowStart).toBe(150);
    expect(session.pages).toEqual([]);
  });

  it("stays loading until the snapshot, and leaves rows that arrive ahead of it to the snapshot", async () => {
    const session = thread(rows(3), null);
    const view = renderThread(session.source);
    await waitFor(() => expect(() => session.handlers()).not.toThrow());

    act(() => session.handlers().onEvent(event(9, "early", "assistant")));
    expect(view.result.current.loading).toBe(true);
    expect(view.result.current.events).toEqual([]);

    act(() => session.handlers().onSnapshot(snapshotOf([event(0, "row-0", "assistant")])));
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.events.map((value) => value.id)).toEqual(["row-0"]);
  });

  it("says why when the stream fails before it sends a window", async () => {
    const session = thread(rows(3), null);
    const view = renderThread(session.source);
    await waitFor(() => expect(() => session.handlers()).not.toThrow());

    act(() => session.handlers().onError?.("no session claude/thread"));

    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBe("no session claude/thread");
  });

  it("replaces stale rows when a reconnect snapshot resets the runtime index", async () => {
    const session = thread([event(0, "notice-0", "system"), event(1, "stale-tail", "assistant")]);
    const view = renderThread(session.source, "pi");

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events.map((value) => value.id)).toEqual(["notice-0", "stale-tail"]);

    act(() => session.handlers().onSnapshot(snapshotOf([event(0, "fresh-message", "assistant")], { sequence: 1 })));

    expect(view.result.current.events.map((value) => value.id)).toEqual(["fresh-message"]);
    expect(view.result.current.sequence).toBe(1);
  });

  it("pages older rows in before the oldest one held, and stops at the first row", async () => {
    const session = thread(rows(150));
    const view = renderThread(session.source);
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(session.pages).toEqual([[{ before: 50 }, 100]]);
    expect(view.result.current.events).toHaveLength(150);
    expect(view.result.current.windowStart).toBe(0);

    // Nothing older: no request at all.
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(session.pages).toHaveLength(1);
  });

  it("keeps paged-in history when a reconnect snapshot has stable indices", async () => {
    const all = rows(250);
    const session = thread(all, { stableIndices: true });
    const view = renderThread(session.source);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.windowStart).toBe(150);

    // The reader scrolls up, so a window of older rows is paged in below the opening one.
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(view.result.current.windowStart).toBe(50);
    expect(view.result.current.events).toHaveLength(200);

    // The stream blips and EventSource reopens it. The sidecar answers every open with the same
    // opening window: the tail, and nothing below it.
    act(() => session.handlers().onSnapshot(snapshotOf(all.slice(150), { windowStart: 150, stableIndices: true })));

    // The rows the reader paged in survive it, and the window still reaches down to them so
    // scrolling further up still has somewhere to go.
    expect(view.result.current.events).toHaveLength(200);
    expect(view.result.current.events[0]?.id).toBe("row-50");
    expect(view.result.current.windowStart).toBe(50);
    expect(view.result.current.sequence).toBe(2);
  });

  it("replaces paged rows when a stable snapshot comes from a rebuilt projection", async () => {
    const all = rows(250);
    const session = thread(all, { stableIndices: true, projectionId: "projection-one" });
    const view = renderThread(session.source, "opencode");

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(view.result.current.events).toHaveLength(200);

    act(() =>
      session.handlers().onSnapshot(
        snapshotOf(all.slice(150), {
          windowStart: 150,
          stableIndices: true,
          projectionId: "projection-one",
        }),
      ),
    );
    expect(view.result.current.events).toHaveLength(200);

    act(() =>
      session.handlers().onSnapshot(
        snapshotOf(all.slice(150), {
          sequence: 3,
          windowStart: 150,
          stableIndices: true,
          projectionId: "projection-two",
        }),
      ),
    );
    expect(view.result.current.events).toHaveLength(100);
    expect(view.result.current.events[0]?.id).toBe("row-150");
    expect(view.result.current.windowStart).toBe(150);
  });

  it("still replaces the window when a snapshot does not claim stable indices", async () => {
    // The same session and the same reconnect, with the flag absent. This is the runtime-backed
    // contract, asserted here so the branch cannot be simplified into an unconditional merge.
    const all = rows(250);
    const session = thread(all);
    const view = renderThread(session.source);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(view.result.current.events).toHaveLength(200);

    act(() => session.handlers().onSnapshot(snapshotOf(all.slice(150), { windowStart: 150 })));

    expect(view.result.current.events).toHaveLength(100);
    expect(view.result.current.events[0]?.id).toBe("row-150");
    expect(view.result.current.windowStart).toBe(150);
  });

  it("does not merge an older page that resolves after a replacement snapshot", async () => {
    const session = thread(rows(101));
    const view = renderThread(session.source, "pi");
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    let resolveOlder: ((page: EventsPage) => void) | undefined;
    session.answerWith(
      () =>
        new Promise<EventsPage>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    act(() => {
      void view.result.current.loadOlder();
    });
    await waitFor(() => expect(resolveOlder).toBeDefined());

    act(() => session.handlers().onSnapshot(snapshotOf([event(0, "fresh-message", "assistant")], { sequence: 1 })));
    await act(async () =>
      resolveOlder?.({
        events: [event(0, "stale-older-page", "system")],
        windowStart: 0,
        usage: null,
      }),
    );

    expect(view.result.current.events.map((value) => value.id)).toEqual(["fresh-message"]);
    expect(view.result.current.windowStart).toBe(0);
  });

  it("initializes usage from the last transcript reading when the snapshot carries none", async () => {
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
    const session = thread(seedEvents);
    const view = renderThread(session.source);
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    // No structured occupancy arrived with the snapshot, so the meter's initial value must come
    // from the transcript's own last reading.
    expect(view.result.current.usage).toEqual({ current: 71_411, limit: null, updatedAt: 2000 });

    // A live reading with a newer timestamp replaces the fallback, exactly as it replaces a
    // structured reading.
    act(() => session.handlers().onUsage?.({ current: 88_000, limit: 200_000, updatedAt: 3000 }));
    expect(view.result.current.usage).toEqual({ current: 88_000, limit: 200_000, updatedAt: 3000 });
  });

  it("keeps naming the session model across a snapshot that blanks usage", async () => {
    // The post-compaction gap: the sidecar stops reporting occupancy for a window that no longer
    // exists, while the model survives it. The switcher reads the model, the meter reads usage, so
    // one blanks and the other must not.
    const session = thread([event(0, "row-0", "assistant")], { sessionModel: "p/m" });
    const view = renderThread(session.source, "opencode");
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.usage).toBeNull();
    expect(view.result.current.sessionModel).toBe("p/m");

    act(() => session.handlers().onSnapshot(snapshotOf([event(0, "row-0", "assistant")], { sessionModel: "p/m" })));

    expect(view.result.current.usage).toBeNull();
    expect(view.result.current.sessionModel).toBe("p/m");
  });
});
