// The service against fakes: what is pinned here is a run's life -- worktrees made before the
// run is registered, contestants fanned out together, facts landing on the records -- not git's
// or the serve's behavior, which their own modules pin against the real things.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArenaBadRequestError,
  ArenaRunBusyError,
  ArenaRunNotFoundError,
  ArenaService,
} from "@/arena/arenaService";
import { ArenaRunRegistry, type ArenaRunRecord } from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import { runOpencodeContestant, type OpencodeContestantBackend } from "@/arena/opencodeContestant";
import type { ContestantDriver, ContestantDrivers } from "@/arena/contestantDriver";
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
  const added: { repoPath: string; path: string; ref: string }[] = [];
  const removed: { repoPath: string; path: string }[] = [];
  const pruned: string[] = [];
  return {
    steps: {
      async assertRepository() {},
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
        { kind: "state", sequence: 1, mode: "nice", events: [], windowStart: 0, runState: "running", queue: { steer: 0, followUp: 0 } },
        {
          kind: "upsert",
          sequence: 2,
          mode: "nice",
          events: [toolEvent(`${sessionId}:read`, "read", ["/repo/README"])],
          windowStart: 0,
          runState: "running",
          queue: { steer: 0, followUp: 0 },
        },
        { kind: "state", sequence: 3, mode: "nice", events: [], windowStart: 0, runState: "idle", queue: { steer: 0, followUp: 0 } },
      ];
      if (options.fail) {
        queueMicrotask(() => {
          listener({ kind: "state", sequence: 1, mode: "nice", events: [], windowStart: 0, runState: "error", queue: { steer: 0, followUp: 0 } });
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
function driversOver(
  backend: OpencodeContestantBackend,
  claude?: ContestantDriver,
): ContestantDrivers {
  return {
    // The serve's end-of-turn marker is the driver's own concern, pinned in its tests; here
    // every turn the fake backend plays is one the serve has marked done.
    opencode: (plan) =>
      runOpencodeContestant(backend, plan, {
        turnOutcome: async () => ({ closed: true, failure: null }),
        permissions: async () => [],
      }),
    claude: claude ?? (async (plan) => {
      plan.onSessionId("claude-session");
      return {
        sessionId: "claude-session",
        events: [toolEvent("claude:0", "Write", ["/repo/claude.ts"])],
        usage: null,
      };
    }),
  };
}

async function service(options: {
  backend?: OpencodeContestantBackend;
  claude?: ContestantDriver;
  defaultRepoPath?: string | null;
} = {}) {
  const root = await arenaRoot();
  const { backend } = options.backend ? { backend: options.backend } : fakeBackend();
  const worktrees = fakeWorktrees();
  const registry = new ArenaRunRegistry();
  const store = new ArenaStore(root);
  const arena = new ArenaService({
    registry,
    store,
    drivers: driversOver(backend, options.claude),
    worktrees: worktrees.steps,
    arenaRoot: root,
    defaultRepoPath: options.defaultRepoPath === undefined ? "/repos/default" : options.defaultRepoPath,
    turnTimeoutMs: 500,
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  });
  return { arena, root, registry, store, worktrees, backend };
}

/**
 * A well-formed create-run request, with overrides.
 *
 * Typed loosely on the way in because the refusal tests pass bodies no valid run could be made
 * of -- a source this arena cannot drive, a relative repoPath -- and those are the requests whose
 * refusals are the point.
 */
const request = (over: Record<string, unknown> = {}): ArenaCreateRunRequest =>
  ({
    prompt: "say one word",
    repoPath: "/repos/one",
    contestants: [{ source: "opencode" }, { source: "opencode" }],
    ...over,
  }) as ArenaCreateRunRequest;

async function whenContestantsSettle(registry: ArenaRunRegistry): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const runs = registry.list();
    const settled = runs.every((run: ArenaRunRecord) =>
      run.contestants.every((c) => c.status === "closed" || c.status === "failed")
    );
    if (runs.length > 0 && settled) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("contestants did not settle within the deadline");
}

test("a run makes every worktree first, registers, then fans the prompt out", async () => {
  const { arena, registry, worktrees, root } = await service();
  const summary = await arena.createRun(request());

  // Two contestants, made as worktrees under the run's own directory before the run was listed.
  expect(worktrees.added.map((one) => one.path)).toEqual([
    join(root, summary.runId, "c1"),
    join(root, summary.runId, "c2"),
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

test("one run duels both harnesses, each contestant driven by the driver its source names", async () => {
  const { arena, registry } = await service();
  const summary = await arena.createRun(
    request({ contestants: [{ source: "opencode" }, { source: "claude" }] }),
  );
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
  const { arena, registry, store, root } = await service();
  const summary = await arena.createRun(request());
  await whenContestantsSettle(registry);

  const reloaded = new ArenaRunRegistry({ initial: store.load() });
  const reArena = new ArenaService({
    registry: reloaded,
    store,
    drivers: driversOver(fakeBackend().backend),
    worktrees: fakeWorktrees().steps,
    arenaRoot: root,
    defaultRepoPath: null,
    turnTimeoutMs: 500,
  });
  const detail = reArena.runDetailFor(summary.runId);
  expect(detail?.contestants[0]?.gitDiff).toBe("diff --git a/README");
  expect(detail?.contestants[0]?.filesRead).toEqual(["/repo/README"]);
});

test("a run with no repository falls back to the configured default, and is refused without one", async () => {
  const configured = await service();
  const summary = await configured.arena.createRun(request({ repoPath: "" }));
  expect(summary.repoPath).toBe("/repos/default");

  const bare = await service({ defaultRepoPath: null });
  await expect(bare.arena.createRun(request({ repoPath: "" }))).rejects.toThrow(
    "a run needs a repository",
  );
});

test("refuses a request no run could be made of, naming what was wrong", async () => {
  const { arena } = await service();
  await expect(arena.createRun(request({ prompt: "" }))).rejects.toThrow(ArenaBadRequestError);
  await expect(arena.createRun(request({ repoPath: "relative/path" }))).rejects.toThrow("absolute");
  await expect(arena.createRun(request({ contestants: [] }))).rejects.toThrow("at least one contestant");
  await expect(
    arena.createRun(request({ contestants: [{ source: "pi" }] })),
  ).rejects.toThrow("cannot drive");
});

test("a worktree failure leaves no run behind and undoes the worktrees it made", async () => {
  const root = await arenaRoot();
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
    arenaRoot: root,
    defaultRepoPath: null,
    turnTimeoutMs: 500,
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  });

  await expect(arena.createRun(request())).rejects.toThrow("git worktree add failed");
  expect(registry.list()).toEqual([]);
  // Every contestant's worktree is put back through removal -- including the one whose add
  // failed and was never made, which the real step refuses by the same check as a stranger's.
  // A teardown that stopped there would leave the first one registered.
  expect(worktrees.removed.map((one) => one.path)).toEqual([
    join(root, "11111111-1111-4111-8111-111111111111", "c1"),
    join(root, "11111111-1111-4111-8111-111111111111", "c2"),
  ]);
  expect(worktrees.pruned).toEqual(["/repos/one"]);
});

test("deleteRun tears a settled run down and leaves nothing behind", async () => {
  const { arena, registry, worktrees } = await service();
  const summary = await arena.createRun(request());
  await whenContestantsSettle(registry);

  await arena.deleteRun(summary.runId);
  expect(worktrees.removed.length).toBe(2);
  expect(registry.get(summary.runId)).toBeUndefined();
  await expect(arena.deleteRun(summary.runId)).rejects.toThrow(ArenaRunNotFoundError);
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
