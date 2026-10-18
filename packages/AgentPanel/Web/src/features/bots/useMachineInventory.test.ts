// A peer's inventory stream follows the machine's data source, not only its id: a save to the data
// source swaps in a fresh one under the same id, and a stream left on the replaced one would keep
// running the old code until something remounted.

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { BotMachine } from "@/features/bots/botMachines";
import { useMachineInventory } from "@/features/bots/useMachineInventory";

/** A data source that counts the inventory streams it opened and still holds open. */
function countingFeed() {
  const streams = { opened: 0, open: 0 };
  const feed = {
    subscribeInventory() {
      streams.opened += 1;
      streams.open += 1;
      return () => {
        streams.open -= 1;
      };
    },
  } as unknown as SidecarDataSource;
  return { feed, streams };
}

describe("useMachineInventory", () => {
  it("moves its stream to a data source swapped in under the same machine id", () => {
    const first = countingFeed();
    const second = countingFeed();
    const { rerender } = renderHook(({ machine }: { machine: BotMachine }) => useMachineInventory(machine, ["/repo"]), {
      initialProps: { machine: { id: "peer", label: "Peer", feed: first.feed } },
    });
    expect(first.streams).toEqual({ opened: 1, open: 1 });

    rerender({ machine: { id: "peer", label: "Peer", feed: second.feed } });

    expect(first.streams).toEqual({ opened: 1, open: 0 });
    expect(second.streams).toEqual({ opened: 1, open: 1 });
  });

  it("keeps its stream through a re-render that only rebuilt the machine and the paths", () => {
    const only = countingFeed();
    const { rerender } = renderHook(
      ({ machine, paths }: { machine: BotMachine; paths: string[] }) => useMachineInventory(machine, paths),
      { initialProps: { machine: { id: "peer", label: "Peer", feed: only.feed }, paths: ["/repo"] } },
    );

    rerender({ machine: { id: "peer", label: "Peer", feed: only.feed }, paths: ["/repo"] });

    expect(only.streams).toEqual({ opened: 1, open: 1 });
  });
});
