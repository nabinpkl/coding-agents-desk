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
import type { ContestantDriver, ContestantDrivers, ContestantResume } from "@/arena/contestants/contestantDriver";
import type { ArenaContestantSummary, ArenaCreateRunRequest } from "@agentdesk/agent-feed-wire";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const worktrees = {
  async assertRepository() {},
  async initRepository() {},
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
  let prompted: string | null = null;
  const drive: ContestantDriver = async (plan) => {
    if (!plan.terminal) throw new Error("no terminal on a terminals plan");
    plan.terminal.onPane(`pane-${name}`, `session-${name}`);
    if ((await loaded) === "fail") throw new Error(`${name} never showed its composer`);
    prompted = await plan.terminal.ready();
    promptedAt = Date.now();
    return { sessionId: `session-${name}`, events: [], usage: null };
  };
  return { drive, load, promptedAt: () => promptedAt, prompted: () => prompted, label: () => name };
}

async function arena(options: { terminalDrivers?: ContestantDrivers | null; killed?: string[]; onKill?: () => void } = {}) {
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
      options.onKill?.();
    },
    worktrees,
    arenaHome: join(root, "home"),
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

describe("lanes opened before the prompt", () => {
  test("wait at the line, ready, until the reader gives the prompt, which every lane then gets", async () => {
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({ terminalDrivers: { claude: claude.drive, opencode: opencode.drive } });
    const run = await service.createRun(request({ prompt: "" }));
    expect(run.prompt).toBe("");
    claude.load("ready");
    opencode.load("ready");
    await until(() => contestants(service).every((c) => c.status === "ready"), "both lanes ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.promptedAt()).toBeNull();

    const given = service.sendPrompt(run.runId, "  say one word  ");
    expect(given.prompt).toBe("say one word");
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect([claude.prompted(), opencode.prompted()]).toEqual(["say one word", "say one word"]);
    expect(service.listRuns()[0]?.prompt).toBe("say one word");
  });

  test("a prompt is given once, never empty, and only to a run that is waiting for one", async () => {
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const { service } = await arena({ terminalDrivers: { claude: claude.drive, opencode: opencode.drive } });
    const run = await service.createRun(request({ prompt: "" }));
    expect(() => service.sendPrompt(run.runId, "   ")).toThrow(/cannot be empty/);
    service.sendPrompt(run.runId, "first");
    expect(() => service.sendPrompt(run.runId, "second")).toThrow(/already has its prompt/);
    expect(() => service.sendPrompt("33333333-3333-4333-8333-333333333333", "x")).toThrow(/no arena run/);
    claude.load("ready");
    opencode.load("ready");
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
  });

  test("a headless run still needs its prompt up front: it has no lanes to open first", async () => {
    const { service } = await arena({ terminalDrivers: null });
    await expect(service.createRun(request({ prompt: "" }))).rejects.toThrow(/needs a prompt/);
  });

  test("removing a run still waiting for its prompt closes its lanes rather than being refused", async () => {
    const killed: string[] = [];
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    // c2 is still on its way up: it leaves only once its pane is ended, as a real harness would.
    const { service } = await arena({
      terminalDrivers: { claude: claude.drive, opencode: opencode.drive },
      killed,
      onKill: () => opencode.load("fail"),
    });
    const run = await service.createRun(request({ prompt: "" }));
    claude.load("ready");
    await until(() => contestants(service)[0]?.status === "ready", "c1 at the line");

    await service.deleteRun(run.runId);
    expect(killed).toEqual(["pane-c1", "pane-c2"]);
    expect(service.listRuns()).toEqual([]);
    expect(claude.promptedAt()).toBeNull();
  });
});

describe("a restart", () => {
  /** Two services over one store and home: the second is the sidecar that came back. */
  async function restartable() {
    const created = await mkdtemp(join(tmpdir(), "arena-restart-"));
    roots.push(created);
    const root = await realpath(created);
    const make = (terminalDrivers: ContestantDrivers | null, drivers?: ContestantDrivers) => {
      const store = new ArenaStore(root);
      const service = new ArenaService({
        registry: new ArenaRunRegistry({ initial: store.load() }),
        store,
        drivers: drivers ?? { opencode: closesAtOnce, claude: closesAtOnce },
        terminalDrivers,
        killPane: async () => {},
        worktrees,
        arenaHome: join(root, "home"),
        turnTimeoutMs: 500,
      });
      return service;
    };
    return { make };
  }

  /** A driver that reaches the start line and then holds its turn open, as a slow harness would. */
  const holdsItsTurn = (name: string): ContestantDriver => async (plan) => {
    plan.terminal!.onPane(`pane-${name}`, `session-${name}`);
    await plan.terminal!.ready();
    return new Promise(() => {});
  };

  /** The driver the restarted sidecar has: it writes down what it was handed to pick up. */
  function pickingUp() {
    const handed: (ContestantResume | undefined)[] = [];
    const prompts: string[] = [];
    const drive: ContestantDriver = async (plan) => {
      const terminal = plan.terminal!;
      handed.push(terminal.resume);
      prompts.push(terminal.resume?.prompted ? plan.prompt : await terminal.ready());
      return { sessionId: terminal.resume?.sessionId ?? "fresh", events: [], usage: null };
    };
    return { drive, handed, prompts };
  }

  test("lanes open and waiting are picked back up from their panes, and still take the prompt", async () => {
    const { make } = await restartable();
    const claude = controllableDriver("c1");
    const opencode = controllableDriver("c2");
    const before = make({ claude: claude.drive, opencode: opencode.drive });
    const run = await before.createRun(request({ prompt: "" }));
    claude.load("ready");
    opencode.load("ready");
    await until(() => contestants(before).every((c) => c.status === "ready"), "both lanes ready");

    const after = pickingUp();
    const service = make({ claude: after.drive, opencode: after.drive });
    service.resumeInterruptedRuns();
    expect(after.handed).toEqual([
      { pane: "pane-c1", sessionId: "session-c1", prompted: false },
      { pane: "pane-c2", sessionId: "session-c2", prompted: false },
    ]);
    service.sendPrompt(run.runId, "say one word");
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect(after.prompts).toEqual(["say one word", "say one word"]);
    expect(contestants(service).map((c) => c.error)).toEqual([null, null]);
  });

  test("a contestant already let go is watched, not held at the line, and its clock is kept", async () => {
    const { make } = await restartable();
    const before = make({ claude: holdsItsTurn("c1"), opencode: holdsItsTurn("c2") });
    await before.createRun(request({ prompt: "say one word" }));
    await until(() => contestants(before).every((c) => c.status === "running"), "both running");
    const startedAt = contestants(before).map((c) => c.startedAt);

    const after = pickingUp();
    const service = make({ claude: after.drive, opencode: after.drive });
    service.resumeInterruptedRuns();
    await until(() => contestants(service).every((c) => c.status === "closed"), "both to close");
    expect(after.handed.every((one) => one?.prompted === true)).toBe(true);
    expect(after.prompts).toEqual(["say one word", "say one word"]);
    expect(contestants(service).map((c) => c.startedAt)).toEqual(startedAt);
  });

  test("a headless contestant cut off mid-turn fails saying why; a settled run is left alone", async () => {
    const { make } = await restartable();
    const hangs: ContestantDriver = async (plan) => {
      plan.onSessionId("headless");
      return new Promise(() => {});
    };
    const before = make(null, { claude: hangs, opencode: hangs });
    await before.createRun(request({ mode: "headless" }));
    await until(() => contestants(before).every((c) => c.status === "running"), "both running");

    const service = make(null);
    service.resumeInterruptedRuns();
    expect(contestants(service).map((c) => [c.status, c.error])).toEqual([
      ["failed", "the sidecar restarted mid-turn, and a headless contestant cannot be picked back up"],
      ["failed", "the sidecar restarted mid-turn, and a headless contestant cannot be picked back up"],
    ]);
  });
});
