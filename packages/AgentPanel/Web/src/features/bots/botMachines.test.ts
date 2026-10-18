// What is worth pinning here is ROUTING, because getting it wrong is silent.
//
// A command sent to the wrong machine does not throw: the Mac's registry answers "no such Bot" for
// one of oracle's, and a session card built on the wrong feed subscribes to a transcript that is
// simply not there. Both read as an empty card rather than as an error, which is the shape
// `AGENTS.md` warns about under "An absent result is a claim about the probe". So the tests below
// are about which machine a Bot resolves to and about a dead peer taking nothing with it.

import { describe, expect, test } from "vitest";
import type { BotView } from "@agentdesk/agent-feed-wire";
import {
  botsOnShownMachines,
  indexBotMachines,
  indexSessionMachines,
  machineKey,
  machinesAreMixed,
  mergeMachineBots,
  type BotMachine,
} from "@/features/bots/botMachines";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/** A stand-in feed: nothing here calls it, and identity is the only property under test. */
const feedFor = (label: string) => ({ label }) as unknown as SidecarDataSource;

const machine = (id: string | undefined, label: string): BotMachine =>
  id === undefined ? { label, feed: feedFor(label) } : { id, label, feed: feedFor(label) };

const bot = (botId: string, sessionIds: readonly string[] = []) =>
  ({
    botId,
    name: botId,
    sessionRefs: sessionIds.map((sessionId) => ({ source: "claude", sessionId })),
  }) as unknown as BotView;

const mac = machine(undefined, "dev");
const oracle = machine("oracle", "oracle");

describe("machineKey", () => {
  test("the panel's own machine cannot collide with a declared peer", () => {
    // Every declared id is at least one character (`sidecarBoard` refuses anything else), so the
    // empty string is reserved for the local sidecar by construction rather than by convention.
    expect(machineKey(mac)).toBe("");
    expect(machineKey(oracle)).toBe("oracle");
  });
});

describe("indexBotMachines", () => {
  test("a Bot resolves to the machine whose roster it arrived in", () => {
    const index = indexBotMachines([
      { machine: mac, bots: [bot("a"), bot("b")] },
      { machine: oracle, bots: [bot("c")] },
    ]);
    expect(index.get("a")).toBe(mac);
    expect(index.get("c")).toBe(oracle);
  });

  test("a Bot on no roster resolves to nothing rather than to the first machine", () => {
    // The caller has to be able to tell "not here yet" from "here, on the default machine": a
    // fallback would send a command for an unknown Bot at whichever sidecar happened to be first.
    const index = indexBotMachines([{ machine: mac, bots: [bot("a")] }]);
    expect(index.get("missing")).toBeUndefined();
  });

  test("a duplicate id keeps its first machine instead of moving", () => {
    // Ids are random UUIDs so this should not happen. If it ever does, a Bot that changes machine
    // between two snapshots would send one command to each, which is worse than being consistently
    // wrong about one of them.
    const index = indexBotMachines([
      { machine: mac, bots: [bot("same")] },
      { machine: oracle, bots: [bot("same")] },
    ]);
    expect(index.get("same")).toBe(mac);
  });
});

describe("indexSessionMachines", () => {
  test("a session routes to the machine of the Bot holding it", () => {
    const index = indexSessionMachines([
      { machine: mac, bots: [bot("a", ["s1"])] },
      { machine: oracle, bots: [bot("c", ["s2", "s3"])] },
    ]);
    expect(index.get("claude:s1")).toBe(mac);
    expect(index.get("claude:s3")).toBe(oracle);
  });

  test("a reference the catalog has lost still routes", () => {
    // Over `sessionRefs` rather than `sessions`, so a transcript the peer cannot read this minute
    // is still addressable: renaming it, or forking from it, has to reach the right machine, and a
    // missing row is exactly the one whose menu a reader reaches for.
    const index = indexSessionMachines([{ machine: oracle, bots: [bot("c", ["gone"])] }]);
    expect(index.get("claude:gone")).toBe(oracle);
  });

  test("a session on no Bot routes nowhere, and the caller decides", () => {
    const index = indexSessionMachines([{ machine: mac, bots: [bot("a", ["s1"])] }]);
    expect(index.get("claude:loose")).toBeUndefined();
  });
});

describe("mergeMachineBots", () => {
  test("the panel's own Bots come first, then the peers by label", () => {
    const zeus = machine("zeus", "zeus");
    const merged = mergeMachineBots([
      { machine: zeus, bots: [bot("z")] },
      { machine: oracle, bots: [bot("o")] },
      { machine: mac, bots: [bot("m")] },
    ]);
    expect(merged.map((entry) => entry.botId)).toEqual(["m", "o", "z"]);
  });

  test("a machine's own order survives the merge", () => {
    const merged = mergeMachineBots([{ machine: mac, bots: [bot("b"), bot("a"), bot("c")] }]);
    expect(merged.map((entry) => entry.botId)).toEqual(["b", "a", "c"]);
  });

  test("a machine that has not answered removes nothing from the ones that have", () => {
    // The case this exists for: oracle goes down and the Mac's canvas must be exactly what it was
    // before oracle was ever declared, not an empty one.
    const merged = mergeMachineBots([
      { machine: mac, bots: [bot("m")] },
      { machine: oracle, bots: [] },
    ]);
    expect(merged.map((entry) => entry.botId)).toEqual(["m"]);
  });
});

describe("machinesAreMixed", () => {
  test("one machine is not mixed, so nothing gets labelled with what the reader knows", () => {
    expect(machinesAreMixed([mac])).toBe(false);
    expect(machinesAreMixed([mac, oracle])).toBe(true);
  });
});

describe("botsOnShownMachines", () => {
  const keyOf = (botId: string): string | undefined =>
    botId.startsWith("o-") ? "oracle" : botId.startsWith("m-") ? "mac" : undefined;

  test("hides only the machines that are hidden", () => {
    const bots = [bot("m-1"), bot("o-1"), bot("m-2")];
    expect(botsOnShownMachines(bots, new Set(["oracle"]), keyOf).map((b) => b.botId)).toEqual(["m-1", "m-2"]);
  });

  test("hands back the same array when nothing is hidden", () => {
    // Identity, not equality: the canvas re-derives this every render, and a fresh array each time
    // would be a new list for every consumer that memoises on it.
    const bots = [bot("m-1")];
    expect(botsOnShownMachines(bots, new Set(), keyOf)).toBe(bots);
  });

  test("keeps a Bot no machine claims, whatever is hidden", () => {
    // Hiding a machine is a statement about that machine. Dropping an unplaceable Bot here would
    // put it behind a control that never named it, with nothing to press to get it back.
    const bots = [bot("stray")];
    expect(botsOnShownMachines(bots, new Set(["oracle", "mac"]), keyOf).map((b) => b.botId)).toEqual(["stray"]);
  });
});
