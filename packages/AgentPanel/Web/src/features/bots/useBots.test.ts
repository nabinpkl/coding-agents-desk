// What the canvas keeps while a machine's Bot stream is down. A sidecar restart drops it every
// time, and the roster it last sent has to stay drawn -- marked as held, so the canvas says it is
// reconnecting rather than that the machine's Bots are gone.

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BotSnapshot, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { BotMachine } from "@/features/bots/botMachines";
import { useBots } from "@/features/bots/useBots";

const BOT = {
  botId: "bot-1",
  name: "AD bot",
  environment: { kind: "directory", path: "/repo" },
  sessionRefs: [],
  sessions: [],
  missingSessionRefs: [],
  metadata: { labels: [], custom: {} },
  grants: [],
  createdAt: 0,
  createdBy: { kind: "user" },
} as unknown as BotView;

/** A machine whose Bot stream the test drives by hand. */
function machine(label: string) {
  const stream: { snapshot?: (snapshot: BotSnapshot) => void; fail?: (reason: string) => void } = {};
  const feed = {
    subscribeBots(onSnapshot: (snapshot: BotSnapshot) => void, onError: (reason: string) => void) {
      stream.snapshot = onSnapshot;
      stream.fail = onError;
      return () => {};
    },
  } as unknown as SidecarDataSource;
  return { machine: { label, feed } satisfies BotMachine, stream };
}

describe("useBots", () => {
  it("keeps a machine's Bots through a dropped stream and says it is holding them", () => {
    const mac = machine("Mac");
    const machines = [mac.machine];
    const { result } = renderHook(() => useBots(machines));

    act(() => mac.stream.snapshot?.({ version: 2, revision: 1, bots: [BOT] }));
    act(() => mac.stream.fail?.("stream failed"));

    expect(result.current.bots.map((bot) => bot.botId)).toEqual(["bot-1"]);
    expect(result.current.error).toBeNull();
    expect(result.current.machineErrors).toEqual([{ label: "Mac", reason: "stream failed", held: true }]);
  });

  it("says nothing is held for a machine that never answered", () => {
    const mac = machine("Mac");
    const machines = [mac.machine];
    const { result } = renderHook(() => useBots(machines));

    act(() => mac.stream.fail?.("stream failed"));

    expect(result.current.bots).toEqual([]);
    expect(result.current.machineErrors).toEqual([{ label: "Mac", reason: "stream failed", held: false }]);
  });
});
