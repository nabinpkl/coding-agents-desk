// The service against fakes: what is pinned here is a run's life -- worktrees made before the
// run is registered, contestants fanned out together, facts landing on the records -- not git's
// or the serve's behavior, which their own modules pin against the real things.

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaBadRequestError, ArenaRunBusyError, ArenaRunNotFoundError, ArenaService } from "@/arena/arenaService";
import { ArenaRunRegistry, type ArenaRunRecord } from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import { runOpencodeContestant, type OpencodeContestantBackend } from "@/arena/contestants/opencodeContestant";
import type { ContestantDriver, ContestantDrivers } from "@/arena/contestants/contestantDriver";
import type { ArenaCreateRunRequest, TimelineEnvelope } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function arenaRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "arena-service-"));
  roots.push(created);
  return await realpath(created);
}

/** Worktree steps that remember instead of running git; the arena module's own tests pin git. */
function fakeWorktrees() {
  const initialized: { path: string; message: string; worktreeFolders: readonly string[] }[] = [];
  const added: { repoPath: string; path: string; ref: string }[] = [];
  const removed: { repoPath: string; path: string }[] = [];
  const pruned: string[] = [];
  return {
    steps: {
      async assertRepository() {},
      async initRepository(options: { path: string; message: string; worktreeFolders: readonly string[] }) {
        initialized.push(options);
      },
      async add(options: { repoPath: string; path: string; ref: string }) {
        added.push(options);
      },
      async remove(options: { repoPath: string; path: string }) {
        removed.push(options);
      },
      async prune(repoPath: string) {
        pruned.push(repoPath);
      },
      async captureDiff() {
        return "diff --git a/README";
      },
    },
    initialized,
    added,
    removed,
    pruned,
  };
}

/** A backend whose every contestant closes on its own, one event in, one envelope out. */
function fakeBackend(
  options: {
    fail?: boolean;
    usage?: { current: number; limit: number | null; updatedAt: number; cost?: number };
  } = {},
) {
  const created: string[] = [];
  const backend: OpencodeContestantBackend = {
    async switchModel() {
      return { requestId: "r", delivery: "immediate" };
    },
    async createSession(_requestId, projectPath) {
      const sessionId = `ses-${created.length + 1}`;
      created.push(`${projectPath}:${sessionId}`);
      return {
        sessionId,
        source: "opencode",
        projectPath,
        title: sessionId,
        lastEventAt: 1,
        activity: "ready",
        capabilities: {
          modes: ["nice"],
          canSend: true,
          canSteer: true,
          canAbort: true,
          canFetchRaw: false,
          canOpenTerminal: true,
          supportsExtensionUi: true,
          canStreamLive: false,
        },
      };
    },
    async subscribe(sessionId, _after, listener) {
      const envelopes: TimelineEnvelope[] = [
        {
          kind: "state",
          sequence: 1,
          mode: "nice",
          events: [],
          windowStart: 0,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
        {
          kind: "upsert",
          sequence: 2,
          mode: "nice",
          events: [toolEvent(`${sessionId}:read`, "read", ["/repo/README"])],
          windowStart: 0,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
        {
          kind: "state",
          sequence: 3,
          mode: "nice",
          events: [],
          windowStart: 0,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      ];
      if (options.fail) {
        queueMicrotask(() => {
          listener({
            kind: "state",
            sequence: 1,
            mode: "nice",
            events: [],
            windowStart: 0,
            runState: "error",
            queue: { steer: 0, followUp: 0 },
          });
        });
        return () => {};
      }
      queueMicrotask(() => {
        for (const one of envelopes) listener(one);
      });
      return () => {};
    },
    async send() {
      if (options.fail) throw new Error("the serve refused the prompt");
      return { requestId: "r", delivery: "immediate" };
    },
    sessionUsage: () => (options.usage === undefined ? null : options.usage),
  };
  return { backend, created };
}

function toolEvent(id: string, tool: string, files: string[]): ActivityEvent {
  return {
    id,
    index: 0,
    revision: 1,
    phase: "complete",
    ts: 1,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool, files }],
  };
}

/**
 * The drivers a run is wired with: opencode over the given fake backend, and a Claude driver
 * that closes at once having named one written file, unless the test hands its own.
 */
function driversOver(backend: OpencodeContestantBackend, claude?: ContestantDriver): ContestantDrivers {
  return {
    // The serve's end-of-turn marker is the driver's own concern, pinned in its tests; here
    // every turn the fake backend plays is one the serve has marked done.
    opencode: (plan) =>
      runOpencodeContestant(backend, plan, {
        lastUserId: async () => null,
        turnOutcome: async () => ({ closed: true, failure: null }),
      }),
    claude:
      claude ??
      (async (plan) => {
        plan.onSessionId("claude-session");
        return {
          sessionId: "claude-session",
          events: [toolEvent("claude:0", "Write", ["/repo/claude.ts"])],
          usage: null,
        };
      }),
  };
}

async function service(
  options: {
    backend?: OpencodeContestantBackend;
    claude?: ContestantDriver;
  } = {},
) {
  const root = await arenaRoot();
  const home = join(root, "home");
  let runs = 0;
  const { backend } = options.backend ? { backend: options.backend } : fakeBackend();
  const worktrees = fakeWorktrees();
  const registry = new ArenaRunRegistry();
  const store = new ArenaStore(root);
  const arena = new ArenaService({
    registry,
    store,
    drivers: driversOver(backend, options.claude),
    worktrees: worktrees.steps,
    arenaHome: home,
    turnTimeoutMs: 500,
    newRunId: () => `11111111-1111-4111-8111-${String(++runs).padStart(12, "0")}`,
  });
  return { arena, root, home, registry, store, worktrees, backend };
}

/**
 * A well-formed create-run request, with overrides.
 *
 * Typed loosely on the way in because the refusal tests pass bodies no valid run could be made
 * of -- a source this arena cannot drive, a relative repoPath -- and those are the requests whose
 * refusals are the point.
 */
const request = (over: Record<string, unknown> = {}): ArenaCreateRunRequest => ({
  prompt: "say one word",
  repoPath: "/repos/one",
  contestants: [{ source: "opencode" }, { source: "opencode" }],
  ...over,
});

async function whenContestantsSettle(registry: ArenaRunRegistry): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const runs = registry.list();
    const settled = runs.every((run: ArenaRunRecord) =>
      run.contestants.every((c) => c.status === "closed" || c.status === "failed"),
    );
    if (runs.length > 0 && settled) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("contestants did not settle within the deadline");
}

test("a run makes every worktree first, registers, then fans the prompt out", async () => {
  const { arena, registry, worktrees, home } = await service();
  const summary = await arena.createRun(request());

  // Two contestants, made as worktrees in the run's own folder before the run was listed.
  expect(worktrees.added.map((one) => one.path)).toEqual([
    join(home, "arena-run-1", "c1"),
    join(home, "arena-run-1", "c2"),
  ]);
  expect(worktrees.added.every((one) => one.ref === "HEAD")).toBe(true);
  expect(summary.contestants.map((c) => c.status)).toEqual(["preparing", "preparing"]);

  await whenContestantsSettle(registry);
  const settled = registry.get(summary.runId);
  expect(settled?.contestants.every((c) => c.status === "closed")).toBe(true);
  expect(settled?.contestants.every((c) => c.sessionId !== null)).toBe(true);
  expect(settled?.contestants[0]?.filesRead).toEqual(["/repo/README"]);
  expect(settled?.contestants[0]?.gitDiff).toBe("diff --git a/README");
});

// A headless run's next prompt continues each contestant's session rather than starting another,
// and the facts are the whole conversation's: the second turn's file joins the first's.
test("a headless run's next prompt continues each session, and its facts add to the first turn's", async () => {
  const continued: (string | undefined)[] = [];
  const requestIds: string[] = [];
  let turn = 0;
  const claude: ContestantDriver = async (plan) => {
    continued.push(plan.continues);
    requestIds.push(plan.requestId);
    turn += 1;
    plan.onSessionId("claude-session");
    return {
      sessionId: "claude-session",
      events: [toolEvent(`claude:${turn}`, "Write", [`/repo/turn${turn}.ts`])],
      usage: null,
    };
  };
  const { arena, registry } = await service({ claude });
  const summary = await arena.createRun(request({ contestants: [{ source: "claude" }] }));
  await whenContestantsSettle(registry);
  expect(arena.sendPrompt(summary.runId, "and now the tests")).toMatchObject({ prompt: "and now the tests", round: 2 });
  await whenContestantsSettle(registry);
  expect(continued).toEqual([undefined, "claude-session"]);
  // A harness deduplicates a send by its request id: one reused for the second prompt was refused,
  // measured live on the serve, as "reused with another command".
  expect(new Set(requestIds).size).toBe(2);
  expect(registry.get(summary.runId)?.contestants[0]?.filesWritten).toEqual(["/repo/turn1.ts", "/repo/turn2.ts"]);
});

test("one run duels both harnesses, each contestant driven by the driver its source names", async () => {
  const { arena, registry } = await service();
  const summary = await arena.createRun(request({ contestants: [{ source: "opencode" }, { source: "claude" }] }));
  await whenContestantsSettle(registry);
  const detail = arena.runDetailFor(summary.runId);
  expect(detail?.contestants.map((one) => [one.source, one.status])).toEqual([
    ["opencode", "closed"],
    ["claude", "closed"],
  ]);
  expect(detail?.contestants[1]?.sessionId).toBe("claude-session");
  expect(detail?.contestants[1]?.filesWritten).toEqual(["/repo/claude.ts"]);
});

test("a failed contestant records its failure as its own fact, not the run's", async () => {
  const { arena, registry } = await service({ backend: fakeBackend({ fail: true }).backend });
  const summary = await arena.createRun(request());
  await whenContestantsSettle(registry);

  const run = registry.get(summary.runId);
  expect(run?.contestants.every((c) => c.status === "failed")).toBe(true);
  expect(run?.contestants.every((c) => c.error !== null)).toBe(true);
  // The run itself stays listed: one contestant failing is a fact about that contestant.
  expect(registry.get(summary.runId)).toBeDefined();
});

test("a run's facts survive a reload, with the diff read back from its own file", async () => {
  const { arena, registry, store, home } = await service();
  const summary = await arena.createRun(request());
  await whenContestantsSettle(registry);

  const reloaded = new ArenaRunRegistry({ initial: store.load() });
  const reArena = new ArenaService({
    registry: reloaded,
    store,
    drivers: driversOver(fakeBackend().backend),
    worktrees: fakeWorktrees().steps,
    arenaHome: home,
    turnTimeoutMs: 500,
  });
  const detail = reArena.runDetailFor(summary.runId);
  expect(detail?.contestants[0]?.gitDiff).toBe("diff --git a/README");
  expect(detail?.contestants[0]?.filesRead).toEqual(["/repo/README"]);
});

test("a run that names no repository gets a new one of its own: its folder, worktrees inside", async () => {
  const { arena, worktrees, home } = await service();
  const summary = await arena.createRun(request({ repoPath: "" }));
  const folder = join(home, "arena-run-1");
  expect([summary.name, summary.repoPath, summary.repoCreated]).toEqual(["arena run 1", folder, true]);
  // The repository is made before any worktree of it, with the worktree folders kept out of it.
  expect(worktrees.initialized).toEqual([
    { path: folder, message: "arena run 1", worktreeFolders: ["c[0-9]*", "manager"] },
  ]);
  expect(worktrees.added.map((one) => [one.repoPath, one.path])).toEqual([
    [folder, join(folder, "c1")],
    [folder, join(folder, "c2")],
  ]);
});

test("a run naming its repository makes none, and its worktrees still go in the run's folder", async () => {
  const { arena, worktrees, home } = await service();
  const summary = await arena.createRun(request({ name: "Bake off: one vs two" }));
  expect([summary.name, summary.repoPath, summary.repoCreated]).toEqual(["Bake off: one vs two", "/repos/one", false]);
  expect(worktrees.initialized).toEqual([]);
  expect(worktrees.added[0]?.path).toBe(join(home, "bake-off-one-vs-two", "c1"));
});

test("runs are named arena run 1, 2, ... past every default name and folder already taken", async () => {
  const { arena, registry, home } = await service();
  expect(arena.newRunDefaults().nextName).toBe("arena run 1");
  await arena.createRun(request());
  expect(arena.newRunDefaults().nextName).toBe("arena run 2");
  // A folder whose run record is gone still holds its number.
  await mkdir(join(home, "arena-run-7"), { recursive: true });
  expect(arena.newRunDefaults().nextName).toBe("arena run 8");
  expect((await arena.createRun(request())).name).toBe("arena run 8");
  await whenContestantsSettle(registry);
});

test("a name another run has, or whose folder is there, is refused, and the refusal leaves nothing", async () => {
  const { arena, registry, home } = await service();
  await arena.createRun(request({ name: "duel" }));
  await expect(arena.createRun(request({ name: "  DUEL " }))).rejects.toThrow(/already a run named like/);
  await mkdir(join(home, "by-hand"));
  await expect(arena.createRun(request({ name: "by hand" }))).rejects.toThrow(/already exists/);
  await expect(arena.createRun(request({ name: "!!!" }))).rejects.toThrow(/letter or digit/);
  await expect(arena.createRun(request({ name: "x".repeat(81) }))).rejects.toThrow(/capped/);
  await expect(arena.createRun(request({ name: "fresh", contestants: [] }))).rejects.toThrow(/contestant/);
  expect(existsSync(join(home, "fresh"))).toBe(false);
  await whenContestantsSettle(registry);
});

test("refuses a request no run could be made of, naming what was wrong", async () => {
  const { arena } = await service();
  await expect(arena.createRun(request({ prompt: "" }))).rejects.toThrow(ArenaBadRequestError);
  await expect(arena.createRun(request({ repoPath: "relative/path" }))).rejects.toThrow("absolute");
  await expect(arena.createRun(request({ contestants: [] }))).rejects.toThrow("at least one contestant");
  await expect(arena.createRun(request({ contestants: [{ source: "pi" }] }))).rejects.toThrow("cannot drive");
});

test("a worktree failure leaves no run behind and undoes the worktrees it made", async () => {
  const root = await arenaRoot();
  const home = join(root, "home");
  const worktrees = fakeWorktrees();
  const failing = {
    ...worktrees.steps,
    add: async (options: { repoPath: string; path: string; ref: string }) => {
      worktrees.added.push(options);
      if (worktrees.added.length === 2) throw new Error("git worktree add failed");
    },
  };
  const registry = new ArenaRunRegistry();
  const arena = new ArenaService({
    registry,
    store: new ArenaStore(root),
    drivers: driversOver(fakeBackend().backend),
    worktrees: failing,
    arenaHome: home,
    turnTimeoutMs: 500,
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  });

  await expect(arena.createRun(request())).rejects.toThrow("git worktree add failed");
  expect(registry.list()).toEqual([]);
  // Every contestant's worktree is put back through removal -- including the one whose add
  // failed and was never made, which the real step refuses by the same check as a stranger's.
  // A teardown that stopped there would leave the first one registered.
  expect(worktrees.removed.map((one) => one.path)).toEqual([
    join(home, "arena-run-1", "c1"),
    join(home, "arena-run-1", "c2"),
  ]);
  expect(worktrees.pruned).toEqual(["/repos/one"]);
  // And the folder goes, so the name it claimed is free again.
  expect(existsSync(join(home, "arena-run-1"))).toBe(false);
});

test("deleteRun tears a settled run down and leaves nothing behind", async () => {
  const { arena, registry, worktrees, home } = await service();
  const summary = await arena.createRun(request());
  await whenContestantsSettle(registry);

  await arena.deleteRun(summary.runId);
  expect(worktrees.removed.length).toBe(2);
  expect(existsSync(join(home, "arena-run-1"))).toBe(false);
  expect(registry.get(summary.runId)).toBeUndefined();
  await expect(arena.deleteRun(summary.runId)).rejects.toThrow(ArenaRunNotFoundError);
});

test("deleteRun takes a run's own repository with it, whole, and leaves a named one's folder alone if it is not empty", async () => {
  const { arena, registry, home } = await service();
  const own = await arena.createRun(request({ repoPath: "" }));
  const named = await arena.createRun(request());
  await whenContestantsSettle(registry);
  await writeFile(join(home, "arena-run-1", "README"), "the run's own repository's file\n");
  await writeFile(join(home, "arena-run-2", "stray"), "not the arena's\n");

  await arena.deleteRun(own.runId);
  await arena.deleteRun(named.runId);
  expect(existsSync(join(home, "arena-run-1"))).toBe(false);
  // A folder that only held worktrees of the reader's repository is removed only when empty.
  expect(existsSync(join(home, "arena-run-2", "stray"))).toBe(true);
  expect(registry.list()).toEqual([]);
});

test("deleteRun refuses a run with a contestant still dueling", async () => {
  const { arena, registry } = await service();
  const summary = await arena.createRun(request());
  // No settling wait: the contestants are mid-run at this moment.
  await expect(arena.deleteRun(summary.runId)).rejects.toThrow(ArenaRunBusyError);
  // And the run is left whole by the refusal, rather than half torn down.
  await whenContestantsSettle(registry);
  expect(registry.get(summary.runId)?.contestants.every((c) => c.status === "closed")).toBe(true);
});
