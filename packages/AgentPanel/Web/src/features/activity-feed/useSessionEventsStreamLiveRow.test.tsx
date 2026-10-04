// A row that arrives while the reader is already watching, and keeps arriving.
//
// The backends with a live mirror have a separate channel for this: a `tail` message the panel
// draws below the thread, retired when the durable transcript names the message. Opencode has
// no mirror, so a running turn arrives as ordinary upserts on the timeline stream -- on an index
// the opening window never covered, once per chunk of words. Two things have to hold for that to
// read as a stream rather than as pages appearing: an unknown index is inserted rather than
// dropped, and a repeat of the same index replaces the row instead of adding one. Nothing else
// on the panel had to change, which is worth a test that says so.
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { event, renderThread, thread } from "@/features/activity-feed/sessionEventsHarness";

describe("a row that streams in past the paged window", () => {
  it("appears, grows in place, and settles without a second row", async () => {
    const session = thread([event(0, "reader-turn", "user")]);
    const view = renderThread(session.source, "opencode");
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const handlers = session.handlers();

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

    act(() => handlers?.onEvent?.(streamed(1, "one two")));
    expect(view.result.current.events[1]?.blocks).toEqual([{ kind: "text", text: "one two" }]);

    // The same revision is the same words, so the feed is not re-rendered for nothing.
    const drawn = view.result.current.events[1];
    act(() => handlers?.onEvent?.(streamed(1, "one two")));
    expect(view.result.current.events[1]).toBe(drawn);

    // The read that ends the step lands the durable message: same row, now complete, and the
    // tool parts the deltas never named arrive with it.
    act(() => handlers?.onEvent?.(streamed(2, "one two", "complete")));
    expect(view.result.current.events).toHaveLength(2);
    expect(view.result.current.events[1]?.phase).toBe("complete");
  });
});
