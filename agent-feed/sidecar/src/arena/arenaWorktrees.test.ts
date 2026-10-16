// Run against real `git worktree`, because what is being pinned is the same thing
// `git/worktree.test.ts` pins from the other side: agreement with git's on-disk behavior, not
// with a fixture of it.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_FOLDERS_PATTERN } from "@/arena/arenaLanes";
import {
  addContestantWorktree,
  assertGitRepository,
  ArenaWorktreeError,
  captureWorktreeDiff,
  initRunRepository,
  removeContestantWorktree,
} from "@/arena/arenaWorktrees";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "arena-"));
  roots.push(created);
  const root = await realpath(created);
  const checkout = join(root, "checkout");
  await run(["git", "init", "-q", "-b", "main", checkout], root);
  await writeFile(join(checkout, "README"), "one\n");
  await run(["git", "add", "README"], checkout);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], checkout);
  return checkout;
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

test("asserts a repository by refusing everything else by name", async () => {
  const plain = await mkdtemp(join(tmpdir(), "arena-"));
  roots.push(plain);
  expect(assertGitRepository(plain)).rejects.toThrow("is not a git repository");
});

test("makes a detached contestant worktree at the ref asked for", async () => {
  const checkout = await repository();
  const path = join(checkout, "..", "c1");
  await addContestantWorktree({ repoPath: checkout, path, ref: "HEAD" });

  // Detached on purpose: a contestant is a throwaway checkout, and `git rev-parse` in it names
  // the same commit the target repo has at HEAD without a branch either side has to clean up.
  const head = await capture(["rev-parse", "HEAD"], checkout);
  const contestantHead = await capture(["rev-parse", "HEAD"], path);
  expect(contestantHead).toBe(head);
});

test("refuses a worktree path that already exists, rather than reusing it", async () => {
  const checkout = await repository();
  const path = join(checkout, "..", "taken");
  await mkdir(path);
  expect(
    addContestantWorktree({ repoPath: checkout, path, ref: "HEAD" }),
  ).rejects.toThrow("already exists");
});

test("removes a contestant worktree it made, uncommitted work included", async () => {
  const checkout = await repository();
  const path = join(checkout, "..", "c1");
  await addContestantWorktree({ repoPath: checkout, path, ref: "HEAD" });
  // A contestant's uncommitted work is its output, not a refusal: the diff was captured first.
  await writeFile(join(path, "README"), "two\n");

  await removeContestantWorktree({ repoPath: checkout, path });
  const listed = await capture(["worktree", "list"], checkout);
  expect(listed.includes(path)).toBe(false);
});

test("refuses to remove another repository's worktree as this one's", async () => {
  const checkout = await repository();
  const other = await repository();
  const path = join(other, "..", "c1");
  await addContestantWorktree({ repoPath: other, path, ref: "HEAD" });

  expect(
    removeContestantWorktree({ repoPath: checkout, path }),
  ).rejects.toThrow(ArenaWorktreeError);
});

test("refuses to remove a directory that is not a worktree at all", async () => {
  const checkout = await repository();
  const plain = await mkdtemp(join(tmpdir(), "arena-"));
  roots.push(plain);
  expect(
    removeContestantWorktree({ repoPath: checkout, path: plain }),
  ).rejects.toThrow("is not a git worktree");
});

test("captures the diff against the ref, untracked files named separately", async () => {
  const checkout = await repository();
  const path = join(checkout, "..", "c1");
  await addContestantWorktree({ repoPath: checkout, path, ref: "HEAD" });
  await writeFile(join(path, "README"), "contestant's edit\n");
  await writeFile(join(path, "new-file.txt"), "untracked\n");

  const diff = await captureWorktreeDiff({ worktreePath: path, ref: "HEAD" });
  expect(diff).toContain("contestant's edit");
  // Deliberate boundary, pinned: a new file is not in `git diff`, and `filesWritten` is where the
  // arena still names it. The diff is bounded by what git tracks.
  expect(diff).not.toContain("new-file.txt");
});

test("a run's own repository: one empty commit, worktrees inside it, and its own status clean", async () => {
  const created = await mkdtemp(join(tmpdir(), "arena-"));
  roots.push(created);
  const folder = join(await realpath(created), "arena-run-1");
  await mkdir(folder);
  // Authored as the arena whatever this machine's git identity, signing or hooks say.
  await initRunRepository({ path: folder, message: "arena run 1", worktreeFolders: [LANE_FOLDERS_PATTERN, "manager"] });

  expect(await capture(["log", "--format=%s|%an", "HEAD"], folder)).toBe("arena run 1|Agent Desk Arena");
  await addContestantWorktree({ repoPath: folder, path: join(folder, "c1"), ref: "HEAD" });
  await addContestantWorktree({ repoPath: folder, path: join(folder, "c2"), ref: "HEAD" });
  // A lane added later, numbered past the first nine, is kept out by the same one pattern.
  await addContestantWorktree({ repoPath: folder, path: join(folder, "c12"), ref: "HEAD" });
  await mkdir(join(folder, "manager"));
  await writeFile(join(folder, "manager", "CLAUDE.md"), "brief\n");
  // The worktrees sit inside the checkout they belong to, without showing up in its status.
  expect(await capture(["status", "--porcelain"], folder)).toBe("");
  await writeFile(join(folder, "c1", "made.txt"), "work\n");
  expect(await capture(["status", "--porcelain"], join(folder, "c1"))).toBe("?? made.txt");
  await removeContestantWorktree({ repoPath: folder, path: join(folder, "c1") });
});

async function capture(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return (await new Response(child.stdout).text()).trim();
}
