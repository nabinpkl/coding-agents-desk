import { describe, expect, test } from "bun:test";
import {
  ArenaRunRegistry,
  contestantSummary,
  afterRestart,
  runDetail,
  runSummary,
  type ArenaContestantRecord,
  type ArenaRunRecord,
} from "@/arena/arenaRun";

const contestant = (over: Partial<ArenaContestantRecord> = {}): ArenaContestantRecord => ({
  contestantId: "c1",
  source: "opencode",
  model: null,
  sessionId: null,
  worktreePath: "/nowhere/c1",
  tmuxSession: null,
  status: "preparing",
  startedAt: null,
  closedAt: null,
  error: null,
  contextTokens: null,
  costUsd: null,
  filesRead: [],
  filesWritten: [],
  outsideReached: [],
  gitDiff: null,
  ...over,
});

const run = (over: Partial<ArenaRunRecord> = {}): ArenaRunRecord => ({
  runId: "11111111-1111-4111-8111-111111111111",
  manager: null,
  name: "arena run 1",
  folder: "/arena/arena-run-1",
  prompt: "say one word",
  round: 1,
  repoPath: "/repos/one",
  repoCreated: false,
  mode: "headless",
  baseRef: "HEAD",
  createdAt: 1,
  contestants: [contestant()],
  ...over,
});

describe("ArenaRunRegistry", () => {
  test("lists newest first, the order a list reads in", () => {
    const registry = new ArenaRunRegistry({
      initial: [run(), run({ runId: "22222222-2222-4222-8222-222222222222", createdAt: 2 })],
    });
    expect(registry.list().map((entry) => entry.createdAt)).toEqual([2, 1]);
  });

  test("updateContestant applies the change and tells the listeners once", () => {
    const registry = new ArenaRunRegistry({ initial: [run()] });
    const heard: number[] = [];
    registry.onChange(() => heard.push(1));

    const applied = registry.updateContestant(run().runId, "c1", (c, now) => {
      c.status = "running";
      c.startedAt = now;
    });
    expect(applied).toBe(true);
    expect(registry.get(run().runId)?.contestants[0]?.status).toBe("running");
    expect(heard.length).toBe(1);
  });

  test("updateContestant reports a missing contestant as false, not a throw", () => {
    const registry = new ArenaRunRegistry({ initial: [run()] });
    expect(registry.updateContestant(run().runId, "c9", () => {})).toBe(false);
  });

  test("remove tells the listeners only when something was removed", () => {
    const registry = new ArenaRunRegistry({ initial: [run()] });
    const heard: number[] = [];
    registry.onChange(() => heard.push(1));
    expect(registry.remove("33333333-3333-4333-8333-333333333333")).toBe(false);
    expect(heard.length).toBe(0);
    expect(registry.remove(run().runId)).toBe(true);
    expect(heard.length).toBe(1);
  });
});

describe("afterRestart", () => {
  test("a terminals contestant with its pane on record is picked back up, let go or not", () => {
    const pane = { tmuxSession: "arena-c1-1111", sessionId: "s1" };
    expect(afterRestart({ mode: "terminals" }, { status: "ready", ...pane }, true)).toEqual({
      drive: { pane: "arena-c1-1111", sessionId: "s1", prompted: false },
    });
    expect(afterRestart({ mode: "terminals" }, { status: "starting", ...pane }, true)).toEqual({
      drive: { pane: "arena-c1-1111", sessionId: "s1", prompted: false },
    });
    expect(afterRestart({ mode: "terminals" }, { status: "running", ...pane }, true)).toEqual({
      drive: { pane: "arena-c1-1111", sessionId: "s1", prompted: true },
    });
  });

  test("one with no pane yet starts over; one that cannot be picked up fails saying why", () => {
    const none = { tmuxSession: null, sessionId: null };
    expect(afterRestart({ mode: "terminals" }, { status: "preparing", ...none }, true)).toEqual({ drive: null });
    expect(afterRestart({ mode: "terminals" }, { status: "ready", ...none }, true)).toHaveProperty("failed");
    expect(afterRestart({ mode: "terminals" }, { status: "ready", tmuxSession: "p", sessionId: "s" }, false))
      .toEqual({ failed: "the sidecar came back with no tmux, so its pane cannot be picked back up" });
    expect(afterRestart({ mode: "headless" }, { status: "running", ...none }, true))
      .toEqual({ failed: "the sidecar restarted mid-turn, and a headless contestant cannot be picked back up" });
  });
});

describe("projections", () => {
  test("summary derives duration from the timestamps it carries", () => {
    const summary = contestantSummary(contestant({ startedAt: 100, closedAt: 350 }));
    expect(summary.durationMs).toBe(250);
    expect(contestantSummary(contestant({ startedAt: 100 })).durationMs).toBeNull();
  });

  test("runDetail prefers the in-memory diff and falls back to the store for a reloaded run", () => {
    const live = run({
      contestants: [
        contestant({ contestantId: "c1", gitDiff: "in memory" }),
        contestant({ contestantId: "c2", gitDiff: null }),
      ],
    });
    const detail = runDetail(live, (c) =>
      c.contestantId === "c2" ? "from the store" : null
    );
    expect(detail.contestants[0]?.gitDiff).toBe("in memory");
    expect(detail.contestants[1]?.gitDiff).toBe("from the store");
  });

  test("summary and detail share identity, so a list row and its facts never disagree", () => {
    const one = run();
    expect(runSummary(one).contestants[0]?.contestantId).toBe(
      runDetail(one, () => null).contestants[0]?.contestantId,
    );
  });
});
