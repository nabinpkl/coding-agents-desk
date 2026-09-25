// The two surfaces that list Bots draw one order, and this is where that order lives.
//
// Worth pinning because the disagreement was silent and it was the reader's own arrangement that
// went missing: the order used to live inside the canvas, so the sidebar's Canvas roster listed the
// same Bots in whatever order the machines had answered in. A Bot third on the strip sat last in
// the list, and nothing about either surface said which one was wrong.

import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BotView, SetBotCanvasCommand } from "@agentdesk/agent-feed-wire";
import { useCanvasRoster } from "@/app/shell-state/useCanvasRoster";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { botFeeds } from "@/features/bots/botMachines";

/** A stand-in Bot: only its id is under test here. */
const bot = (botId: string) =>
  ({ botId, name: botId, sessions: [], sessionRefs: [], missingSessionRefs: [] } as unknown as BotView);
const ids = (bots: readonly { botId: string }[]): string[] => bots.map((each) => each.botId);
const bots = [bot("a"), bot("b"), bot("c")];
/** Every canvas write the roster sent, in order, and the answer it is given. */
const sent: { botId: string; command: SetBotCanvasCommand }[] = [];
let answer: () => Promise<BotView> = async () => bots[0]!;
const feed = {
  setBotCanvas: (botId: string, command: SetBotCanvasCommand) => {
    sent.push({ botId, command });
    return answer();
  },
} as unknown as SidecarDataSource;
const machine = { label: "this machine", feed };
const feeds = botFeeds(feed, [machine], () => machine, () => machine);
const roster = (initial: BotView[] = bots) => renderHook(
  ({ roster: current }) => useCanvasRoster({ bots: current, settled: true }, feeds),
  { initialProps: { roster: initial } },
);

describe("the canvas order both surfaces read", () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    answer = async () => bots[0]!;
  });

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
    const off = [bots[0]!, { ...bots[1]!, offCanvas: true }, bots[2]!];
    const { result, rerender } = roster(off);
    expect(ids(result.current.canvasBots)).toEqual(["a", "c"]);
    act(() => result.current.moveBot("c", "a"));
    expect(ids(result.current.orderedBots)).toEqual(["c", "a", "b"]);
    rerender({ roster: bots });
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

describe("what is on the canvas, which the Bot's record holds", () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    answer = async () => bots[0]!;
  });

  it("reads the off-canvas sets from the records, not from this browser", () => {
    const { result } = roster([
      { ...bots[0]!, offCanvas: true },
      { ...bots[1]!, offCanvasSessionRefs: [{ source: "claude", sessionId: "s1" }] },
      bots[2]!,
    ]);
    expect(result.current.detachedBotIds).toEqual(new Set(["a"]));
    expect(result.current.detachedSessionKeys).toEqual(new Set(["claude:s1"]));
    expect(Object.keys(localStorage).filter((key) => key.includes("off-canvas"))).toEqual([]);
  });

  it("asks the Bot's machine to change it, and changes nothing locally until it answers", () => {
    const { result } = roster();
    act(() => result.current.toggleBotOnCanvas(bots[1]!));
    expect(sent).toEqual([{ botId: "b", command: { onCanvas: false } }]);
    // The stream brings the change back; until it does, the canvas shows what the record says.
    expect(ids(result.current.canvasBots)).toEqual(["a", "b", "c"]);
  });

  it("takes a session off every Bot holding it", () => {
    const holding = { ...bots[2]!, sessionRefs: [{ source: "codex", sessionId: "s2" }] } as BotView;
    const { result } = roster([bots[0]!, bots[1]!, holding]);
    act(() => result.current.removeSessionFromCanvas({ source: "codex", sessionId: "s2" }));
    expect(sent).toEqual([{
      botId: "c",
      command: { sessions: [{ source: "codex", sessionId: "s2", onCanvas: false }] },
    }]);
  });

  it("says so when the change does not land, rather than looking like a dead click", async () => {
    answer = async () => { throw new Error("bot-store-failed"); };
    const { result } = roster();
    act(() => result.current.toggleBotOnCanvas(bots[0]!));
    await waitFor(() => expect(result.current.canvasError?.message)
      .toBe("Could not change a on the canvas: bot-store-failed"));
  });
});
