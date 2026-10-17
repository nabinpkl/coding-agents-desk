// A run's judge through a real service and real files, over fake panes and fake transcripts: what
// is pinned is the order (brief, then pane), the read-only spelling each harness is started with,
// the folder kept current as contestants settle, and the judge ended with its run.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaCreateRunRequest } from "@agentdesk/agent-feed-wire";
import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaBadRequestError, ArenaService } from "@/arena/arenaService";
import { ArenaStore } from "@/arena/arenaStore";
import type { ContestantDriver } from "@/arena/contestants/contestantDriver";
import { ArenaJudges, type JudgeSteps } from "@/arena/judge/arenaJudges";

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
    return "diff --git a/x b/x\n+x\n";
  },
};

/** A terminals contestant that comes up, takes the prompt, and closes the moment it is given one. */
const closesOnPrompt: ContestantDriver = async (plan) => {
  plan.terminal!.onPane(`pane-${plan.requestId}`, `session-${plan.requestId}`);
  await plan.terminal!.ready();
  return { sessionId: `session-${plan.requestId}`, events: [], usage: null };
};

async function arena(options: { failStart?: boolean } = {}) {
  const created = await mkdtemp(join(tmpdir(), "arena-judges-"));
  roots.push(created);
  const root = await realpath(created);
  const registry = new ArenaRunRegistry();
  const started: { harness: string; cwd: string; command?: string[]; briefThere: boolean }[] = [];
  const killed: string[] = [];
  const steps: JudgeSteps = {
    startClaude: async ({ cwd, command }) => {
      started.push({ harness: "claude", cwd, command, briefThere: existsSync(join(cwd, "CLAUDE.md")) });
      if (options.failStart) throw new Error("tmux said no");
      return "judge-pane";
    },
    openOpencode: async (_requestId, cwd) => {
      started.push({ harness: "opencode", cwd, briefThere: existsSync(join(cwd, "AGENTS.md")) });
      return "ses-judge";
    },
    startOpencode: async () => "judge-tui",
    killPane: async (pane) => {
      killed.push(pane);
    },
    renderTranscript: async (_source, sessionId) => `the session ${sessionId} said its piece`,
    storedDiff: () => null,
  };
  const judges = new ArenaJudges({ registry, steps, claude: { binary: "/bin/claude" }, newSessionId: () => "judge-id" });
  const service = new ArenaService({
    registry,
    store: new ArenaStore(join(root, "store")),
    drivers: { opencode: closesOnPrompt, claude: closesOnPrompt },
    terminalDrivers: { opencode: closesOnPrompt, claude: closesOnPrompt },
    judges,
    killPane: async () => {},
    worktrees,
    arenaHome: join(root, "home"),
    turnTimeoutMs: 500,
    newRunId: () => "33333333-3333-4333-8333-333333333333",
  });
  return { service, registry, judges, started, killed, home: join(root, "home") };
}

const request = (over: Partial<ArenaCreateRunRequest> = {}): ArenaCreateRunRequest => ({
  prompt: "",
  contestants: [{ source: "claude" }, { source: "opencode" }],
  judge: "claude",
  ...over,
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a Claude judge starts in the run's judge folder, in plan mode, after its brief is there", async () => {
  const { service, started, home } = await arena();
  const run = await service.createRun(request());
  const folder = join(home, "arena-run-1", "judge");
  expect(run.judge).toEqual({ source: "claude", status: "starting", folder, sessionId: null, tmuxSession: null, error: null });
  await until(() => service.listRuns()[0]?.judge?.status === "open", "the judge to open");
  expect(service.listRuns()[0]?.judge).toMatchObject({ sessionId: "judge-id", tmuxSession: "judge-pane" });
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ harness: "claude", cwd: folder, briefThere: true });
  expect(started[0]!.command!.slice(-2)).toEqual(["--permission-mode", "plan"]);
  expect(started[0]!.command).toContain("judge-id");
});

test("an opencode judge's session is made in the folder, with its brief named for opencode", async () => {
  const { service, started, home } = await arena();
  await service.createRun(request({ judge: "opencode" }));
  await until(() => service.listRuns()[0]?.judge?.status === "open", "the judge to open");
  expect(started[0]).toMatchObject({ harness: "opencode", cwd: join(home, "arena-run-1", "judge"), briefThere: true });
  expect(service.listRuns()[0]?.judge).toMatchObject({ sessionId: "ses-judge", tmuxSession: "judge-tui" });
});

test("a judge that cannot start fails on its own record, and the lanes go on", async () => {
  const { service } = await arena({ failStart: true });
  await service.createRun(request());
  await until(() => service.listRuns()[0]?.judge?.status === "failed", "the judge to fail");
  expect(service.listRuns()[0]?.judge?.error).toBe("tmux said no");
  expect(service.listRuns()[0]?.contestants.every((one) => one.status !== "failed")).toBe(true);
});

test("the folder follows the run: the prompt, then each settled contestant's transcript and diff", async () => {
  const { service, home } = await arena();
  const run = await service.createRun(request());
  const folder = join(home, "arena-run-1", "judge");
  await until(() => service.listRuns()[0]?.judge?.status === "open", "the judge to open");
  expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toContain("The run has not been given its first prompt yet.");

  service.sendPrompt(run.runId, "name a tree");
  await until(() => existsSync(join(folder, "c2.md")), "the transcripts");
  await until(() => readFileSync(join(folder, "CLAUDE.md"), "utf8").includes("name a tree"), "the brief");
  const nonce = /<transcript-([0-9a-f]+)>/.exec(readFileSync(join(folder, "CLAUDE.md"), "utf8"))![1]!;
  expect(readFileSync(join(folder, "c1.md"), "utf8")).toContain(`<transcript-${nonce}>\nthe session session-`);
  expect(readFileSync(join(folder, "c1.diff"), "utf8")).toBe("diff --git a/x b/x\n+x\n");
  await until(() => readFileSync(join(folder, "CLAUDE.md"), "utf8").includes("+1 -0 in 1 file"), "the facts");
});

test("removing the run ends the judge's pane and its folder", async () => {
  const { service, killed, home } = await arena();
  const run = await service.createRun(request({ prompt: "say one word" }));
  await until(() => service.listRuns()[0]?.judge?.status === "open", "the judge to open");
  await until(() => service.listRuns()[0]?.contestants.every((one) => one.status === "closed") ?? false, "the turns");
  await service.deleteRun(run.runId);
  expect(killed).toEqual(["judge-pane"]);
  expect(existsSync(join(home, "arena-run-1", "judge"))).toBe(false);
});

test("a judge still starting when the sidecar went down is failed saying so; an open one is briefed afresh", async () => {
  const { service, registry, judges } = await arena();
  await service.createRun(request());
  await until(() => service.listRuns()[0]?.judge?.status === "open", "the judge to open");
  registry.updateRun("33333333-3333-4333-8333-333333333333", (one) => {
    one.judge = { ...one.judge!, status: "starting" };
  });
  judges.resume();
  expect(service.listRuns()[0]?.judge).toMatchObject({
    status: "failed",
    error: "the sidecar restarted while the judge was starting",
  });
});

test("a judge is a terminals run's alone, and one this machine cannot start is refused", async () => {
  const { service } = await arena();
  await expect(service.createRun(request({ mode: "headless", prompt: "x" }))).rejects.toThrow(
    "only a terminals run can have a judge",
  );
  await expect(service.createRun(request({ judge: "codex" as never }))).rejects.toBeInstanceOf(ArenaBadRequestError);
});
