// Naming a Father across machines: the Bot's own sidecar clears its siblings, and the panel clears
// the Fathers other machines name once the naming has landed.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { botFeeds, type BotMachine } from "@/features/bots/botMachines";
import { useBotRecordCommands } from "@/app/shell-state/useBotRecordCommands";

function machine(label: string, updateBot = vi.fn(async () => ({}))): BotMachine {
  return { label, id: label, feed: { updateBot } as unknown as SidecarDataSource } as BotMachine;
}

function bot(botId: string, fatherSessionId?: string): BotView {
  return {
    botId,
    name: botId,
    sessions: [],
    ...(fatherSessionId === undefined ? {} : { fatherSession: { source: "claude", sessionId: fatherSessionId } }),
  } as unknown as BotView;
}

function setup(bots: BotView[], machineOf: Record<string, BotMachine>, all: BotMachine[]) {
  const setError = vi.fn();
  const feeds = botFeeds(all[0]!.feed, all, (id) => machineOf[id], () => undefined, () => bots);
  const { result } = renderHook(() => useBotRecordCommands(feeds, setError));
  return { result, setError };
}

describe("setFatherBotSession", () => {
  it("names the Father on its own machine, then clears the one a peer names", async () => {
    const mac = machine("mac");
    const oracle = machine("oracle");
    const named = bot("mac-bot");
    const sibling = bot("mac-sibling", "old-local");
    const peer = bot("oracle-bot", "old-peer");
    const { result, setError } = setup(
      [named, sibling, peer],
      { "mac-bot": mac, "mac-sibling": mac, "oracle-bot": oracle },
      [mac, oracle],
    );

    act(() => result.current.setFatherBotSession(named, { source: "claude", sessionId: "s1" }));

    await waitFor(() => expect(oracle.feed.updateBot).toHaveBeenCalledWith("oracle-bot", { fatherSession: null }));
    expect(mac.feed.updateBot).toHaveBeenCalledTimes(1);
    expect(mac.feed.updateBot).toHaveBeenCalledWith("mac-bot", {
      fatherSession: { source: "claude", sessionId: "s1" },
    });
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it("clears nothing elsewhere when the naming fails, and says which one did", async () => {
    const mac = machine("mac", vi.fn(async () => { throw new Error("not attached"); }));
    const oracle = machine("oracle");
    const named = bot("mac-bot");
    const { result, setError } = setup(
      [named, bot("oracle-bot", "old-peer")],
      { "mac-bot": mac, "oracle-bot": oracle },
      [mac, oracle],
    );

    act(() => result.current.setFatherBotSession(named, { source: "claude", sessionId: "s1" }));

    await waitFor(() => expect(setError).toHaveBeenLastCalledWith({
      session: "claude:s1",
      message: "Could not name s1 the Father of mac-bot: not attached",
    }));
    expect(oracle.feed.updateBot).not.toHaveBeenCalled();
  });

  it("clearing a Father touches no other machine", async () => {
    const mac = machine("mac");
    const oracle = machine("oracle");
    const named = bot("mac-bot", "s1");
    const { result } = setup(
      [named, bot("oracle-bot", "old-peer")],
      { "mac-bot": mac, "oracle-bot": oracle },
      [mac, oracle],
    );

    act(() => result.current.setFatherBotSession(named, null));

    await waitFor(() => expect(mac.feed.updateBot).toHaveBeenCalledWith("mac-bot", { fatherSession: null }));
    expect(oracle.feed.updateBot).not.toHaveBeenCalled();
  });
});
