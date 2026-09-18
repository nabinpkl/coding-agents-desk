// The two surfaces that list Bots draw one order, and this is where that order lives.
//
// Worth pinning because the disagreement was silent and it was the reader's own arrangement that
// went missing: the order used to live inside the canvas, so the sidebar's Canvas roster listed the
// same Bots in whatever order the machines had answered in. A Bot third on the strip sat last in
// the list, and nothing about either surface said which one was wrong.

import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";

/** A stand-in Bot: only its id is under test here. */
const bot = (botId: string) =>
  ({ botId, name: botId, sessions: [], sessionRefs: [], missingSessionRefs: [] } as unknown as BotView);
const ids = (bots: readonly { botId: string }[]): string[] => bots.map((each) => each.botId);
const bots = [bot("a"), bot("b"), bot("c")];
const roster = () => renderHook(() => useCanvasRoster({ bots, settled: true }));

describe("the canvas order both surfaces read", () => {
  beforeEach(() => localStorage.clear());

  it("hands the sidebar's roster and the strip the same arrangement", () => {
    const { result } = roster();
    expect(ids(result.current.orderedBots)).toEqual(["a", "b", "c"]);
    act(() => result.current.moveBot("c", "a"));
    expect(ids(result.current.orderedBots)).toEqual(["c", "a", "b"]);
    expect(ids(result.current.canvasBots)).toEqual(["c", "a", "b"]);
  });

  it("leaves a Bot with no card where it stands rather than at the end", () => {
    // The strip can only move among the cards it is SHOWING, so a move written from those
    // positions would hold nothing else, and a Bot put back would return to the end of the list
    // instead of to its place. Naming both Bots is what keeps the absent one addressed.
    const { result } = roster();
    act(() => result.current.toggleBotOnCanvas(bots[1]!));
    expect(ids(result.current.canvasBots)).toEqual(["a", "c"]);
    act(() => result.current.moveBot("c", "a"));
    expect(ids(result.current.orderedBots)).toEqual(["c", "a", "b"]);
    act(() => result.current.toggleBotOnCanvas(bots[1]!));
    expect(ids(result.current.canvasBots)).toEqual(["c", "a", "b"]);
  });

  it("remembers the arrangement across a reload", () => {
    const first = roster();
    act(() => first.result.current.moveBot("c", "a"));
    first.unmount();
    expect(ids(roster().result.current.orderedBots)).toEqual(["c", "a", "b"]);
  });

  it("ignores a move naming a Bot the roster does not hold", () => {
    const { result } = roster();
    act(() => result.current.moveBot("c", "gone"));
    expect(ids(result.current.orderedBots)).toEqual(["a", "b", "c"]);
  });
});
