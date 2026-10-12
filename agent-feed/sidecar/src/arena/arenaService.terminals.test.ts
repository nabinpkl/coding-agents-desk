// The terminals mode against fake drivers: what is pinned here is the run's half of it -- the
// pane and status each contestant passes through, the one start line every contestant waits at,
// the mode a run is given, and panes ended only when the run is deleted. What a driver does in
// tmux is `terminalContestants.test.ts`'s.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaBadRequestError, ArenaService } from "@/arena/arenaService";
import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import type { ContestantDriver, ContestantDrivers } from "@/arena/contestantDriver";
import type { ArenaContestantSummary, ArenaCreateRunRequest } from "@agentdesk/agent-feed-wire";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const worktrees = {
  async assertRepository() {},
  async add() {},
  async remove() {},
  async prune() {},
  async captureDiff() {
    return "";
  },
};

/** A driver that closes at once with no facts, for the side of a run a test is not about. */
const closesAtOnce: ContestantDriver = async (plan) => {
  plan.onSessionId("headless");
  return { sessionId: "headless", events: [], usage: null };
};

/**
 * A terminals driver whose harness "loads" when the test says: it announces its pane, waits for
 * `load`, then reaches the start line -- or throws there, for a harness that never came up.
 */
function controllableDriver(name: string) {
  let load: (outcome: "ready" | "fail") => void = () => {};
  const loaded = new Promise<"ready" | "fail">((resolve) => {
    load = resolve;
  });
  let promptedAt: number | null = null;
  const drive: ContestantDriver = async (plan) => {
    if (!plan.terminal) throw new Error("no terminal on a terminals plan");
    plan.terminal.onPane(`pane-${name}`, `session-${name}`);
    if ((await loaded) === "fail") throw new Error(`${name} never showed its composer`);
    await plan.terminal.ready();
    promptedAt = Date.now();
    return { sessionId: `session-${name}`, events: [], usage: null };
  };
  return { drive, load, promptedAt: () => promptedAt, label: () => name };
}

async function arena(options: { terminalDrivers?: ContestantDrivers | null; killed?: string[] } = {}) {
  const created = await mkdtemp(join(tmpdir(), "arena-terminals-"));
  roots.push(created);
  const root = await realpath(created);
  const registry = new ArenaRunRegistry();
  const service = new ArenaService({
    registry,
    store: new ArenaStore(root),
    drivers: { opencode: closesAtOnce, claude: closesAtOnce },
    terminalDrivers: options.terminalDrivers,
    killPane: async (pane) => {
      options.killed?.push(pane);
    },
    worktrees,
    arenaRoot: root,
    defaultRepoPath: "/repos/default",
    turnTimeoutMs: 500,
    newRunId: () => "22222222-2222-4222-8222-222222222222",
  });
  return { service, registry };
}

const request = (over: Partial<ArenaCreateRunRequest> = {}): ArenaCreateRunRequest => ({
  prompt: "say one word",
  repoPath: "/repos/one",
  contestants: [{ source: "claude" }, { source: "opencode" }],
  ...over,
});

function contestants(service: ArenaService): ArenaContestantSummary[] {
  return service.listRuns()[0]?.contestants ?? [];
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the run's mode", () => {
  test("is terminals by default where there are terminal drivers, headless where there are none", async () => {
    const withTmux = await arena({ terminalDrivers: { claude: closesAtOnce, opencode: closesAtOnce } });
    expect(withTmux.service.modes()).toEqual(["terminals", "headless"]);
    expect((await withTmux.service.createRun(request())).mode).toBe("terminals");

    const without = await arena({ terminalDrivers: null });
    expect(without.service.modes()).toEqual(["headless"]);
    expect((await without.service.createRun(request())).mode).toBe("headless");
  });

  test("a terminals run on a machine with no tmux is refused, naming why", async () => {
    const { service } = await arena({ terminalDrivers: null });
    await expect(service.createRun(request({ mode: "terminals" }))).rejects.toThrow(ArenaBadRequestError);
    await expect(service.createRun(request({ mode: "terminals" }))).rejects.toThrow(/no tmux/);
  });

  test("headless can still be asked for where tmux is, and drives no pane", async () => {
    const { service } = await arena({ terminalDrivers: { claude: closesAtOnce, opencode: closesAtOnce } });
    await service.createRun(request({ mode: "headless" }));
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect(contestants(service).map((c) => c.tmuxSession)).toEqual([null, null]);
  });
});

describe("the start line", () => {
  test("holds a ready contestant until every contestant is ready, then prompts them together", async () => {
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({ terminalDrivers: { claude: claude.drive, opencode: opencode.drive } });
    await service.createRun(request());

    await until(() => contestants(service).every((c) => c.status === "starting"), "both panes");
    expect(contestants(service).map((c) => c.tmuxSession)).toEqual(["pane-c1", "pane-c2"]);
    expect(contestants(service).map((c) => c.sessionId)).toEqual(["session-c1", "session-c2"]);
    // A pane is not a turn: nothing is on the clock while the harnesses load.
    expect(contestants(service).map((c) => c.startedAt)).toEqual([null, null]);

    claude.load("ready");
    await until(() => contestants(service)[0]?.status === "ready", "c1 to be ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.promptedAt()).toBeNull();
    expect(contestants(service)[1]?.status).toBe("starting");

    opencode.load("ready");
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect(claude.promptedAt()).not.toBeNull();
    expect(opencode.promptedAt()).not.toBeNull();
    expect(contestants(service).every((c) => c.startedAt !== null)).toBe(true);
  });

  test("a contestant that fails before the line lets the others go rather than holding them", async () => {
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({ terminalDrivers: { claude: claude.drive, opencode: opencode.drive } });
    await service.createRun(request());
    await until(() => contestants(service).every((c) => c.status === "starting"), "both panes");

    claude.load("ready");
    opencode.load("fail");
    await until(() => contestants(service)[0]?.status === "closed", "c1 to close");
    const [first, second] = contestants(service);
    expect(first?.status).toBe("closed");
    expect(second?.status).toBe("failed");
    expect(second?.error).toContain("never showed its composer");
    // Its pane stays on the record, open for the reader to see why.
    expect(second?.tmuxSession).toBe("pane-c2");
  });
});

describe("panes", () => {
  test("outlive their contestants' turns and end only when the run is deleted", async () => {
    const killed: string[] = [];
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({
      terminalDrivers: { claude: claude.drive, opencode: opencode.drive },
      killed,
    });
    const run = await service.createRun(request());
    claude.load("ready");
    opencode.load("ready");
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect(killed).toEqual([]);

    await service.deleteRun(run.runId);
    expect(killed).toEqual(["pane-c1", "pane-c2"]);
  });

  test("a run still at the start line cannot be deleted out from under it", async () => {
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({ terminalDrivers: { claude: claude.drive, opencode: opencode.drive } });
    const run = await service.createRun(request());
    await until(() => contestants(service).every((c) => c.status === "starting"), "both panes");
    await expect(service.deleteRun(run.runId)).rejects.toThrow(/still has a contestant/);
    claude.load("fail");
    opencode.load("fail");
  });
});
