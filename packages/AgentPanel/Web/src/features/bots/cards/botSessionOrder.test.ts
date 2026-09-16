/**
 * Translating a drag on a card into the order the Bot is asked to hold.
 *
 * The cases worth pinning down are all about the two lists disagreeing: the cards on screen are a
 * subset of the Bot's order, so an index from one of them means nothing in the other.
 */

import { describe, expect, it } from "vitest";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { reorderSessionRefs } from "@/features/bots/cards/botSessionOrder";

const ref = (sessionId: string): BotSessionRef => ({ source: "claude", sessionId });
const ids = (refs: readonly BotSessionRef[]): string[] => refs.map((each) => each.sessionId);

const ORDER = [ref("a"), ref("b"), ref("c"), ref("d")];

describe("reorderSessionRefs", () => {
  it("drops a card past the neighbour it was carried over", () => {
    const moved = reorderSessionRefs(ORDER, ORDER, 0, 2);

    expect(ids(moved!.sessionRefs)).toEqual(["b", "c", "a", "d"]);
    expect(moved!.moved.sessionId).toBe("a");
  });

  it("drops a card in front of the neighbour when the carry went the other way", () => {
    expect(ids(reorderSessionRefs(ORDER, ORDER, 3, 1)!.sessionRefs)).toEqual(["a", "d", "b", "c"]);
  });

  it("keeps the references the card is not showing, in the places they were in", () => {
    // `b` is off the canvas, so the card lays out a, c, d and a drag names those. An order sent
    // without `b` is refused by the sidecar, and rightly: it reads as a detach.
    const laidOut = [ref("a"), ref("c"), ref("d")];

    const moved = reorderSessionRefs(ORDER, laidOut, 2, 0);

    expect(ids(moved!.sessionRefs)).toEqual(["d", "a", "b", "c"]);
  });

  it("sends the Bot's own reference rather than the summary the card was drawn from", () => {
    // A row is rendered from a `SessionSummary`, which satisfies `BotSessionRef` and carries a
    // title and timestamps besides. Forwarding it would put all of that on the wire.
    const laidOut = [
      { ...ref("a"), title: "A long title", lastEventAt: 12 } as unknown as BotSessionRef,
      ref("b"),
    ];

    const moved = reorderSessionRefs(ORDER, laidOut, 0, 1);

    expect(moved!.moved).toEqual({ source: "claude", sessionId: "a" });
    expect(moved!.sessionRefs.every((each) => Object.keys(each).length === 2)).toBe(true);
  });

  it("answers nothing when the drag ended where it started, so no order is sent", () => {
    expect(reorderSessionRefs(ORDER, ORDER, 1, 1)).toBeNull();
  });

  it("answers nothing for a card the Bot's order does not hold", () => {
    // What a session that has been started but not yet attached is: on the canvas, in no order.
    const laidOut = [ref("a"), ref("fresh")];

    expect(reorderSessionRefs(ORDER, laidOut, 1, 0)).toBeNull();
  });
});
