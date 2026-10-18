import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaStore, ArenaStoreError } from "@/arena/arenaStore";
import type { ArenaRunRecord } from "@/arena/arenaRun";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function arenaRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "arena-store-"));
  roots.push(created);
  // Canonical: `/tmp` is a symlink on macOS, and a store that joins its own root into paths
  // should be tested against the resolved root git and the arena both see.
  return await realpath(created);
}

const run = (over: Partial<ArenaRunRecord> = {}): ArenaRunRecord => ({
  runId: "11111111-1111-4111-8111-111111111111",
  manager: null,
  name: "arena run 1",
  folder: "/arena/arena-run-1",
  prompt: "say one word",
  round: 1,
  repoPath: "/repos/one",
  repoCreated: false,
  baseRef: "HEAD",
  mode: "headless",
  createdAt: 1,
  contestants: [
    {
      contestantId: "c1",
      source: "opencode",
      model: null,
      sessionId: "ses-1",
      worktreePath: "/nowhere/c1",
      tmuxSession: null,
      status: "closed",
      startedAt: 1,
      closedAt: 2,
      error: null,
      contextTokens: 100,
      costUsd: 0.001,
      filesRead: ["/repos/one/README"],
      filesWritten: [],
      outsideReached: [{ path: "/nowhere/c2/notes.md", how: "read", rival: "c2" }],
      gitDiff: "diff --git a/README",
    },
  ],
  ...over,
});

test("round-trips a run, and the diff rides its own file rather than the index", async () => {
  const root = await arenaRoot();
  const store = new ArenaStore(root);
  store.save([run()]);
  expect(store.load()).toEqual([run({ contestants: [{ ...run().contestants[0]!, gitDiff: null }] })]);

  store.writeContestantDiff(run().runId, "c1", "the diff");
  expect(store.readContestantDiff(run().runId, "c1")).toBe("the diff");
  // The diff never rides the index, so a reload that has not read the diff file yet cannot
  // carry it by accident.
  expect(store.load()[0]!.contestants[0]!.gitDiff).toBeNull();

  const index = await readFile(join(root, "runs.json"), "utf8");
  expect(index).not.toContain("the diff");
  expect(await readFile(join(root, run().runId, "c1.diff"), "utf8")).toBe("the diff");
});

test("a run that duelled both harnesses reloads with each contestant's source intact", async () => {
  // Measured: a store that read back only opencode refused to boot a sidecar that had ever
  // run a Claude contestant, which is every sidecar after the first bake-off.
  const root = await arenaRoot();
  const store = new ArenaStore(root);
  const opencode = run().contestants[0]!;
  const mixed = run({ contestants: [opencode, { ...opencode, contestantId: "c2", source: "claude" }] });
  store.save([mixed]);
  expect(store.load()[0]!.contestants.map((one) => one.source)).toEqual(["opencode", "claude"]);
});

test("a missing store is no runs, not an error: the arena starts empty", async () => {
  const store = new ArenaStore(await arenaRoot());
  expect(store.load()).toEqual([]);
});

test("a malformed store throws rather than quietly truncating the run list", async () => {
  const root = await arenaRoot();
  const store = new ArenaStore(root);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "runs.json"), "{not json");
  expect(() => store.load()).toThrow(ArenaStoreError);
});

test("a run reloads with its name, its folder and whether the arena made its repository", async () => {
  const store = new ArenaStore(await arenaRoot());
  store.save([run({ name: "bake off", folder: "/arena/bake-off", repoPath: "/arena/bake-off", repoCreated: true })]);
  const [loaded] = store.load();
  expect([loaded?.name, loaded?.folder, loaded?.repoCreated]).toEqual(["bake off", "/arena/bake-off", true]);
});

test("a run on disk with no name, folder or mode is a broken store, not a run to guess at", async () => {
  const root = await arenaRoot();
  const store = new ArenaStore(root);
  const { writeFileSync } = await import("node:fs");
  for (const missing of ["name", "folder", "repoCreated", "mode"]) {
    const { [missing as keyof ArenaRunRecord]: _dropped, ...rest } = run();
    writeFileSync(join(root, "runs.json"), JSON.stringify([rest]));
    expect(() => store.load()).toThrow(ArenaStoreError);
  }
});

test("deleteRunDirectory removes exactly the run's directory under the root", async () => {
  const root = await arenaRoot();
  const store = new ArenaStore(root);
  const runId = run().runId;
  store.writeContestantDiff(runId, "c1", "diff");
  expect(existsSync(join(root, runId, "c1.diff"))).toBe(true);

  store.deleteRunDirectory(runId);
  expect(existsSync(join(root, runId))).toBe(false);
  expect(existsSync(join(root, "runs.json"))).toBe(false);
});

test("deleteRunDirectory refuses an id that is not one, before any delete happens", async () => {
  const store = new ArenaStore(await arenaRoot());
  expect(() => store.deleteRunDirectory("../escape")).toThrow(ArenaStoreError);
  expect(() => store.deleteRunDirectory("")).toThrow(ArenaStoreError);
});

test("refuses a relative arena root, which a delete would interpret against any cwd", () => {
  expect(() => new ArenaStore("arena/relative")).toThrow(ArenaStoreError);
});
