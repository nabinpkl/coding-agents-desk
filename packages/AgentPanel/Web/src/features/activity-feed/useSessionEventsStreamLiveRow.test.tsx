// A row that arrives while the reader is already watching, and keeps arriving.
//
// The backends with a live mirror have a separate channel for this: a `tail` message the panel
// draws below the thread, retired when the durable transcript names the message. Opencode has
// no mirror, so a running turn arrives as ordinary upserts on the timeline stream -- on an index
// the opening window never covered, once per chunk of words. Two things have to hold for that to
// read as a stream rather than as pages appearing: an unknown index is inserted rather than
// dropped, and a repeat of the same index replaces the row instead of adding one. Nothing else
// on the panel had to change, which is worth a test that says so.
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

function event(index: number, id: string, type: ActivityEvent["type"]): ActivityEvent {
  return { index, id, revision: 0, phase: "complete", ts: index, type, blocks: [] };
}

describe("a row that streams in past the paged window", () => {
  it("appears, grows in place, and settles without a second row", async () => {
    const paged = [event(0, "reader-turn", "user")];
    let handlers: SessionEventsHandlers | undefined;
    const source: AgentDataSource = stubDataSource({
      fetchEventsPage: async (_session, offset, limit) => ({
        events: paged.filter((value) => value.index >= offset && value.index < offset + limit),
        total: paged.length,
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
    const view = renderHook(() => useSessionEventsStream("opencode", "ses-1", "nice"), { wrapper });
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    const streamed = (revision: number, text: string, phase: ActivityEvent["phase"] = "streaming"): ActivityEvent => ({
      ...event(1, "opencode:msg-1", "assistant"),
      revision,
      phase,
      blocks: [{ kind: "text", text }],
    });

    act(() => handlers?.onEvent?.(streamed(0, "one ")));
    expect(view.result.current.events.map((value) => value.id)).toEqual([
      "reader-turn",
      "opencode:msg-1",
    ]);
    // The total widens past what was paged, which is what lets the feed's own bottom be the
    // end of the thread rather than the end of the opening window.
    expect(view.result.current.total).toBe(2);

    act(() => handlers?.onEvent?.(streamed(1, "one two")));
    expect(view.result.current.total).toBe(2);
    expect(view.result.current.events[1]?.blocks).toEqual([{ kind: "text", text: "one two" }]);

    // The same revision is the same words, so the feed is not re-rendered for nothing.
    const drawn = view.result.current.events[1];
    act(() => handlers?.onEvent?.(streamed(1, "one two")));
    expect(view.result.current.events[1]).toBe(drawn);

    // The read that ends the step lands the durable message: same row, now complete, and the
    // tool parts the deltas never named arrive with it.
    act(() => handlers?.onEvent?.(streamed(2, "one two", "complete")));
    expect(view.result.current.total).toBe(2);
    expect(view.result.current.events[1]?.phase).toBe("complete");
  });
});
