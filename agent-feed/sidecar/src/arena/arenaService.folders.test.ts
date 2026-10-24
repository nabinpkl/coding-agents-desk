// The folder a run names, against fake git: a repository is used as it is, and anything else
// refuses the run before anything is made -- a plain folder included, which only the reader's own
// request makes a repository of (ADR-0154).

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaBadRequestError, ArenaService } from "@/arena/arenaService";
import { ArenaFolderRefusedError, makeFolderRepository } from "@/arena/arenaWorktrees";
import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import type { ContestantDriver } from "@/arena/contestants/contestantDriver";
import type { ArenaFolderCheck } from "@agentdesk/agent-feed-wire";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Every lane answers at once; what is pinned here is what happens before any lane runs. */
const answer: ContestantDriver = async (plan) => {
  plan.onSessionId("session");
  return { sessionId: "session", events: [], usage: null };
};

async function arena(folders: Record<string, Omit<ArenaFolderCheck, "path">>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arena-folders-")));
  roots.push(root);
  const initialized: { path: string; message: string; worktreeFolders: readonly string[] }[] = [];
  const added: string[] = [];
  // A folder made a repository reads as one afterwards, the way the filesystem would answer.
  const worktrees = {
    async inspectFolder(path: string): Promise<ArenaFolderCheck> {
      return { path, ...folders[path]! };
    },
    async initRepository(options: { path: string; message: string; worktreeFolders: readonly string[] }) {
      initialized.push(options);
      if (folders[options.path]) folders[options.path] = { repository: true, problem: null };
    },
    async add(options: { repoPath: string }) {
      added.push(options.repoPath);
    },
    async remove() {},
    async prune() {},
    async captureDiff() {
      return "";
    },
  };
  const service = new ArenaService({
    registry: new ArenaRunRegistry(),
    store: new ArenaStore(root),
    drivers: { opencode: answer, claude: answer },
    worktrees,
    arenaHome: join(root, "home"),
    turnTimeoutMs: 500,
    newRunId: () => "44444444-4444-4444-8444-444444444444",
  });
  return { service, worktrees, initialized, added, home: join(root, "home") };
}

const request = (repoPath: string) => ({
  prompt: "add a cache",
  repoPath,
  mode: "headless" as const,
  contestants: [{ source: "claude" as const }],
});

test("a run on a plain folder is refused, and makes nothing of it", async () => {
  const { service, initialized, home } = await arena({ "/Users/me/notes": { repository: false, problem: null } });
  const refused = service.createRun(request("/Users/me/notes"));
  expect(refused).rejects.toThrow(ArenaBadRequestError);
  expect(refused).rejects.toThrow('"/Users/me/notes" is not a git repository yet');
  await refused.catch(() => undefined);
  expect(initialized).toEqual([]);
  expect(existsSync(join(home, "arena-run-1"))).toBe(false);
});

test("a plain folder the reader asks to be made a repository is one, and a run then takes it", async () => {
  const { service, worktrees, initialized, added } = await arena({
    "/Users/me/notes": { repository: false, problem: null },
  });
  expect(await makeFolderRepository(worktrees, "/Users/me/notes")).toEqual({
    path: "/Users/me/notes",
    repository: true,
    problem: null,
  });
  expect(initialized).toEqual([
    { path: "/Users/me/notes", message: "The folder as the arena found it", worktreeFolders: [] },
  ]);
  const run = await service.createRun(request("/Users/me/notes"));
  expect(added).toEqual(["/Users/me/notes"]);
  // Not the run's own: deleting the run never takes the reader's folder with it.
  expect(run.repoCreated).toBe(false);
});

test("asking to make a repository of one already, or of a folder a run cannot use, makes nothing", async () => {
  const { worktrees, initialized } = await arena({
    "/Users/me/app": { repository: true, problem: null },
    "/elsewhere": { repository: false, problem: "is outside the home folder" },
  });
  expect((await makeFolderRepository(worktrees, "/Users/me/app")).repository).toBe(true);
  expect(makeFolderRepository(worktrees, "/elsewhere")).rejects.toThrow(ArenaFolderRefusedError);
  expect(makeFolderRepository(worktrees, "/elsewhere")).rejects.toThrow('"/elsewhere" is outside the home folder');
  await makeFolderRepository(worktrees, "/elsewhere").catch(() => undefined);
  expect(initialized).toEqual([]);
});

test("a repository is used as it is", async () => {
  const { service, initialized } = await arena({ "/Users/me/app": { repository: true, problem: null } });
  await service.createRun(request("/Users/me/app"));
  expect(initialized).toEqual([]);
});

test("a folder a run cannot use refuses it before anything is made", async () => {
  const { service, initialized, home } = await arena({
    "/elsewhere": { repository: false, problem: "is not a git repository, and is outside the home folder" },
  });
  const refused = service.createRun(request("/elsewhere"));
  expect(refused).rejects.toThrow(ArenaBadRequestError);
  expect(refused).rejects.toThrow('"/elsewhere" is not a git repository, and is outside the home folder');
  await refused.catch(() => undefined);
  expect(initialized).toEqual([]);
  expect(existsSync(join(home, "arena-run-1"))).toBe(false);
});
