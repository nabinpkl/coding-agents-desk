// A run's manager through a real service and real files, over fake panes and fake transcripts: what
// is pinned is the order (brief, then pane), the edit-free spelling each harness is started with,
// the folder kept current as contestants settle, lanes added to a run before its first prompt, and
// the manager ended with its run.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaCreateRunRequest } from "@agentdesk/agent-feed-wire";
import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaBadRequestError, ArenaRunBusyError, ArenaService } from "@/arena/arenaService";
import { ArenaStore } from "@/arena/arenaStore";
import type { ContestantDriver } from "@/arena/contestants/contestantDriver";
import { ArenaManagers, type ManagerSteps } from "@/arena/manager/arenaManagers";

const roots: string[] = [];
/** The model each drive was planned with, in the order the drives began. */
const plannedModels: (string | null)[] = [];

afterEach(async () => {
  plannedModels.splice(0);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const worktrees = {
  async assertRepository() {},
  async initRepository() {},
  async add() {},
  async remove() {},
  async prune() {},
  async captureDiff() {
    return "diff --git a/x b/x\n+x\n";
  },
};

/** A terminals contestant that comes up, takes the prompt, and closes the moment it is given one. */
const closesOnPrompt: ContestantDriver = async (plan) => {
  plannedModels.push(plan.model);
  plan.terminal!.onPane(`pane-${plan.requestId}`, `session-${plan.requestId}`);
  await plan.terminal!.ready();
  return { sessionId: `session-${plan.requestId}`, events: [], usage: null };
};

async function arena(options: { failStart?: boolean } = {}) {
  const created = await mkdtemp(join(tmpdir(), "arena-managers-"));
  roots.push(created);
  const root = await realpath(created);
  const registry = new ArenaRunRegistry();
  const started: { harness: string; cwd: string; command?: string[]; briefThere: boolean }[] = [];
  const killed: string[] = [];
  const steps: ManagerSteps = {
    startClaude: async ({ cwd, command }) => {
      started.push({ harness: "claude", cwd, command, briefThere: existsSync(join(cwd, "CLAUDE.md")) });
      if (options.failStart) throw new Error("tmux said no");
      return "manager-pane";
    },
    openOpencode: async (_requestId, cwd) => {
      started.push({ harness: "opencode", cwd, briefThere: existsSync(join(cwd, "AGENTS.md")) });
      return "ses-manager";
    },
    startOpencode: async () => "manager-tui",
    killPane: async (pane) => {
      killed.push(pane);
    },
    renderTranscript: async (_source, sessionId) => `the session ${sessionId} said its piece`,
    storedDiff: () => null,
  };
  const managers = new ArenaManagers({ registry, steps, claude: { binary: "/bin/claude" }, api: "http://127.0.0.1:7682", newSessionId: () => "manager-id" });
  /** A service over the arena's state, as a sidecar starting on it makes one. */
  const serve = () => new ArenaService({
    registry,
    store: new ArenaStore(join(root, "store")),
    drivers: { opencode: closesOnPrompt, claude: closesOnPrompt },
    terminalDrivers: { opencode: closesOnPrompt, claude: closesOnPrompt },
    managers,
    killPane: async () => {},
    worktrees,
    arenaHome: join(root, "home"),
    turnTimeoutMs: 500,
    newRunId: () => "33333333-3333-4333-8333-333333333333",
  });
  const service = serve();
  const restarted = () => {
    const again = serve();
    again.resumeInterruptedRuns();
    return again;
  };
  return { service, restarted, registry, managers, started, killed, home: join(root, "home") };
}

const request = (over: Partial<ArenaCreateRunRequest> = {}): ArenaCreateRunRequest => ({
  prompt: "",
  contestants: [{ source: "claude" }, { source: "opencode" }],
  manager: "claude",
  ...over,
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a Claude manager starts in the run's manager folder, without its edit tools, after its brief is there", async () => {
  const { service, started, home } = await arena();
  const run = await service.createRun(request());
  const folder = join(home, "arena-run-1", "manager");
  expect(run.manager).toEqual({ source: "claude", status: "starting", folder, sessionId: null, tmuxSession: null, error: null });
  await until(() => service.listRuns()[0]?.manager?.status === "open", "the manager to open");
  expect(service.listRuns()[0]?.manager).toMatchObject({ sessionId: "manager-id", tmuxSession: "manager-pane" });
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ harness: "claude", cwd: folder, briefThere: true });
  expect(started[0]!.command!.slice(-2)).toEqual(["--disallowedTools", "Edit,Write,NotebookEdit"]);
  expect(started[0]!.command).not.toContain("--permission-mode");
  expect(started[0]!.command).toContain("manager-id");
});

test("an opencode manager's session is made in the folder, with its brief named for opencode", async () => {
  const { service, started, home } = await arena();
  await service.createRun(request({ manager: "opencode" }));
  await until(() => service.listRuns()[0]?.manager?.status === "open", "the manager to open");
  expect(started[0]).toMatchObject({ harness: "opencode", cwd: join(home, "arena-run-1", "manager"), briefThere: true });
  expect(service.listRuns()[0]?.manager).toMatchObject({ sessionId: "ses-manager", tmuxSession: "manager-tui" });
});

test("a manager that cannot start fails on its own record, and the lanes go on", async () => {
  const { service } = await arena({ failStart: true });
  await service.createRun(request());
  await until(() => service.listRuns()[0]?.manager?.status === "failed", "the manager to fail");
  expect(service.listRuns()[0]?.manager?.error).toBe("tmux said no");
  expect(service.listRuns()[0]?.contestants.every((one) => one.status !== "failed")).toBe(true);
});

test("the folder follows the run: the prompt, then each settled contestant's transcript and diff", async () => {
  const { service, home } = await arena();
  const run = await service.createRun(request());
  const folder = join(home, "arena-run-1", "manager");
  await until(() => service.listRuns()[0]?.manager?.status === "open", "the manager to open");
  expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toContain("has been given 0 prompts");

  service.sendPrompt(run.runId, "name a tree");
  await until(() => existsSync(join(folder, "c2.md")), "the transcripts");
  await until(() => readFileSync(join(folder, "CLAUDE.md"), "utf8").includes("name a tree"), "the brief");
  const nonce = /<transcript-([0-9a-f]+)>/.exec(readFileSync(join(folder, "CLAUDE.md"), "utf8"))![1]!;
  expect(readFileSync(join(folder, "c1.md"), "utf8")).toContain(`<transcript-${nonce}>\nthe session session-`);
  expect(readFileSync(join(folder, "c1.diff"), "utf8")).toBe("diff --git a/x b/x\n+x\n");
  await until(() => readFileSync(join(folder, "CLAUDE.md"), "utf8").includes("+1 -0 in 1 file"), "the facts");
});

test("removing the run ends the manager's pane and its folder", async () => {
  const { service, killed, home } = await arena();
  const run = await service.createRun(request({ prompt: "say one word" }));
  await until(() => service.listRuns()[0]?.manager?.status === "open", "the manager to open");
  await until(() => service.listRuns()[0]?.contestants.every((one) => one.status === "closed") ?? false, "the turns");
  await service.deleteRun(run.runId);
  expect(killed).toEqual(["manager-pane"]);
  expect(existsSync(join(home, "arena-run-1", "manager"))).toBe(false);
});

test("a manager still starting when the sidecar went down is failed saying so; an open one is briefed afresh", async () => {
  const { service, registry, managers } = await arena();
  await service.createRun(request());
  await until(() => service.listRuns()[0]?.manager?.status === "open", "the manager to open");
  registry.updateRun("33333333-3333-4333-8333-333333333333", (one) => {
    one.manager = { ...one.manager!, status: "starting" };
  });
  managers.resume();
  expect(service.listRuns()[0]?.manager).toMatchObject({
    status: "failed",
    error: "the sidecar restarted while the manager was starting",
  });
});

test("a manager is a terminals run's alone, and one this machine cannot start is refused", async () => {
  const { service } = await arena();
  await expect(service.createRun(request({ mode: "headless", prompt: "x" }))).rejects.toThrow(
    "only a terminals run can have a manager",
  );
  await expect(service.createRun(request({ manager: "codex" as never }))).rejects.toBeInstanceOf(ArenaBadRequestError);
});

test("a run with a manager may start with no lanes, and takes them, each on its model, until its first prompt", async () => {
  const { service, home } = await arena();
  const run = await service.createRun(request({ contestants: [] }));
  expect(run.contestants).toEqual([]);
  expect(() => service.sendPrompt(run.runId, "too soon")).toThrow("this run has no lanes yet");
  await expect(service.addContestants(run.runId, [{ source: "opencode", model: "haiku" }])).rejects.toThrow(
    'whose model is named "provider/model"',
  );

  const added = await service.addContestants(run.runId, [{ source: "claude", model: "haiku" }, { source: "opencode" }]);
  expect(added.contestants.map(({ contestantId, model, worktreePath }) => ({ contestantId, model, worktreePath }))).toEqual([
    { contestantId: "c1", model: "haiku", worktreePath: join(home, "arena-run-1", "c1") },
    { contestantId: "c2", model: null, worktreePath: join(home, "arena-run-1", "c2") },
  ]);
  const more = await service.addContestants(run.runId, [{ source: "opencode", model: "opencode/big-pickle" }]);
  expect(more.contestants.map((one) => one.contestantId)).toEqual(["c1", "c2", "c3"]);

  service.sendPrompt(run.runId, "name a tree");
  await until(() => service.listRuns()[0]?.contestants.every((one) => one.status === "closed") ?? false, "every lane to close");
  expect(plannedModels).toEqual(["haiku", null, "opencode/big-pickle"]);
  await expect(service.addContestants(run.runId, [{ source: "claude" }])).rejects.toBeInstanceOf(ArenaRunBusyError);
});

test("a run with no lanes needs a manager to add them, and no prompt it could not yet be given", async () => {
  const { service } = await arena();
  await expect(service.createRun(request({ contestants: [], manager: null }))).rejects.toThrow("at least one contestant");
  await expect(service.createRun(request({ contestants: [], prompt: "x" }))).rejects.toThrow("at least one contestant");
  await expect(service.createRun(request({ contestants: [{ source: "claude", model: "two words" }] }))).rejects.toThrow(
    "which is not a model name",
  );
  // A name an object inherits is not a harness, and a run holding one would not load after a restart.
  for (const source of ["toString", "__proto__", "constructor"]) {
    await expect(service.createRun(request({ contestants: [{ source: source as never }] }))).rejects.toThrow(
      `names source "${source}"`,
    );
  }
});

test("a run with no lanes yet still takes them after the sidecar restarts", async () => {
  const { service, restarted } = await arena();
  const run = await service.createRun(request({ contestants: [] }));
  const again = restarted();
  const added = await again.addContestants(run.runId, [{ source: "claude", model: "haiku" }]);
  expect(added.contestants.map((one) => one.contestantId)).toEqual(["c1"]);
  again.sendPrompt(run.runId, "name a tree");
  await until(() => again.listRuns()[0]?.contestants[0]?.status === "closed", "the lane to close");
});
