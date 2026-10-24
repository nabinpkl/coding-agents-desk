// The folder a run names, against fake git: a repository is used as it is, a plain folder is made
// one with its files as the base, and a folder a run cannot use refuses the run before anything is
// made (ADR-0153).

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaBadRequestError, ArenaService } from "@/arena/arenaService";
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
  const service = new ArenaService({
    registry: new ArenaRunRegistry(),
    store: new ArenaStore(root),
    drivers: { opencode: answer, claude: answer },
    worktrees: {
      async inspectFolder(path) {
        return { path, ...folders[path]! };
      },
      async initRepository(options) {
        initialized.push(options);
      },
      async add(options) {
        added.push(options.repoPath);
      },
      async remove() {},
      async prune() {},
      async captureDiff() {
        return "";
      },
    },
    arenaHome: join(root, "home"),
    turnTimeoutMs: 500,
    newRunId: () => "44444444-4444-4444-8444-444444444444",
  });
  return { service, initialized, added, home: join(root, "home") };
}

const request = (repoPath: string) => ({
  prompt: "add a cache",
  repoPath,
  mode: "headless" as const,
  contestants: [{ source: "claude" as const }],
});

test("a plain folder is made a repository, its files the base, and is the run's repository", async () => {
  const { service, initialized, added } = await arena({ "/Users/me/notes": { repository: false, problem: null } });
  const run = await service.createRun(request("/Users/me/notes"));
  expect(initialized).toEqual([
    { path: "/Users/me/notes", message: "arena run 1: the folder as found", worktreeFolders: [] },
  ]);
  expect(added).toEqual(["/Users/me/notes"]);
  // Not the run's own: deleting the run never takes the reader's folder with it.
  expect([run.repoPath, run.repoCreated]).toEqual(["/Users/me/notes", false]);
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

test("says what a run would make of each folder asked about", async () => {
  const { service } = await arena({
    "/a": { repository: true, problem: null },
    "/b": { repository: false, problem: "does not exist" },
  });
  expect(await service.inspectFolders(["/a", "/b"])).toEqual([
    { path: "/a", repository: true, problem: null },
    { path: "/b", repository: false, problem: "does not exist" },
  ]);
});
