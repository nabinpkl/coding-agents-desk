import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { event, renderThread, snapshotOf, thread } from "@/features/activity-feed/sessionEventsHarness";

/**
 * A thread whose stream drops keeps its rows and says it is reconnecting. A sidecar restart drops
 * every stream at once, and rows that stay look live unless something on the card says otherwise.
 */
describe("useSessionEventsStream reconnecting", () => {
  it("is reconnecting from a drop until the stream opens again, and keeps its rows throughout", async () => {
    const session = thread([event(0, "e0", "user"), event(1, "e1", "assistant")]);
    const view = renderThread(session.source);
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.reconnecting).toBe(false);

    act(() => session.handlers().onError?.());
    expect(view.result.current.reconnecting).toBe(true);
    expect(view.result.current.events.map((row) => row.id)).toEqual(["e0", "e1"]);
    expect(view.result.current.error).toBeNull();

    act(() => session.handlers().onOpen?.());
    expect(view.result.current.reconnecting).toBe(false);
  });

  it("is cleared by a snapshot too, for a source that never reports opening", async () => {
    const session = thread([event(0, "e0", "user")]);
    const view = renderThread(session.source);
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    act(() => session.handlers().onError?.());
    act(() => session.handlers().onSnapshot(snapshotOf([event(0, "e0", "user")])));
    expect(view.result.current.reconnecting).toBe(false);
  });

  it("is not reconnecting when the stream never delivered, which is an error instead", async () => {
    const session = thread([], null);
    const view = renderThread(session.source);

    act(() => session.handlers().onError?.("no session claude/thread"));
    expect(view.result.current.reconnecting).toBe(false);
    expect(view.result.current.error).toBe("no session claude/thread");
  });
});
