// Run against real `git worktree` output rather than a fixture of it, because what is being pinned
// is agreement with git's on-disk format, and a fixture would agree with whoever wrote it.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryBelongsTo, forgetWorktrees, readWorktree } from "./worktree.ts";

const roots: string[] = [];

afterEach(async () => {
  forgetWorktrees();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "worktree-"));
  roots.push(created);
  // Canonical, because `/tmp` is a symlink on macOS and git records the resolved path. Comparing
  // an unresolved path against git's own is a test that fails for a reason the module is right
  // about.
  const root = await realpath(created);
  const checkout = join(root, "checkout");
  await run(["git", "init", "-q", "-b", "main", checkout], root);
  await writeFile(join(checkout, "README"), "x\n");
  await run(["git", "add", "README"], checkout);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], checkout);
  return checkout;
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await process.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

test("a main checkout is not a worktree, because its .git is a directory", async () => {
  const checkout = await repository();
  expect(await readWorktree(checkout)).toBeNull();
});

test("names the checkout a linked worktree belongs to, and the branch it is on", async () => {
  const checkout = await repository();
  const linked = join(checkout, "..", "linked");
  await run(["git", "worktree", "add", "-q", linked, "-b", "side"], checkout);

  expect(await readWorktree(linked)).toEqual({ mainCheckout: checkout, branch: "side" });
});

test("reports a detached worktree with no branch rather than refusing it", async () => {
  // `agent-desk-testflight-prev` is exactly this: a real worktree of this repository, checked out
  // at a commit. It belongs to its checkout and has no branch to name.
  const checkout = await repository();
  const linked = join(checkout, "..", "detached");
  await run(["git", "worktree", "add", "-q", "--detach", linked], checkout);

  const worktree = await readWorktree(linked);
  expect(worktree?.mainCheckout).toBe(checkout);
  expect(worktree?.branch).toBeNull();
});

test("links a worktree that lives OUTSIDE its checkout, which containment would miss", async () => {
  // The measurement this module exists for. One worktree here sits inside the checkout and one
  // outside it, and a path-prefix test gets the second wrong while looking right on the first.
  const checkout = await repository();
  const inside = join(checkout, "nested", "in-tree");
  const outside = join(checkout, "..", "out-of-tree");
  await run(["git", "worktree", "add", "-q", inside, "-b", "in"], checkout);
  await run(["git", "worktree", "add", "-q", outside, "-b", "out"], checkout);

  expect(await directoryBelongsTo(inside, checkout)).toBe(true);
  expect(await directoryBelongsTo(outside, checkout)).toBe(true);
  expect(outside.startsWith(checkout)).toBe(false);
});

test("a directory is its own checkout, and an unrelated one is not", async () => {
  const checkout = await repository();
  const other = await repository();

  expect(await directoryBelongsTo(checkout, checkout)).toBe(true);
  expect(await directoryBelongsTo(other, checkout)).toBe(false);
});

test("answers null for a directory that is not a repository at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-plain-"));
  roots.push(root);
  expect(await readWorktree(root)).toBeNull();
  expect(await directoryBelongsTo(root, "/somewhere")).toBe(false);
});

test("ignores a .git file that is not a worktree pointer", async () => {
  // A submodule's `.git` is also a file, and it points somewhere with no `/worktrees/` in it.
  const root = await mkdtemp(join(tmpdir(), "worktree-submodule-"));
  roots.push(root);
  await writeFile(join(root, ".git"), "gitdir: ../.git/modules/thing\n");
  expect(await readWorktree(root)).toBeNull();
});
