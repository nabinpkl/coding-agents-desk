// The git worktrees an arena run makes: one detached checkout per contestant, and the diff that
// shows what a contestant did to its own.
//
// `git/worktree.ts` is the sibling that owns fork worktrees, and its shape is deliberately not
// this one: a fork is a reader's named BRANCH inside the checkout, visible in `git branch` and
// never colliding with a peer's. An arena contestant is a throwaway checkout at a chosen base
// ref, diffed against that ref at close and removed afterwards, so it is DETACHED -- no branch
// to collide, no branch list to pollute -- and it lives in its run's folder in the arena home, a
// path the sidecar chose, never a path a request named. The refusal discipline is shared:
// everything here either succeeds having done what it said, or throws naming what it refused to do.
//
// `runGit` is the same ten lines as `git/worktree.ts`'s private runner, kept local rather than
// exported from there: that module's surface is its worktree answers, and widening it for a
// second consumer is a change to a careful file this one does not need. A third consumer earns
// the shared export.

import { appendFile, mkdir, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { readWorktree } from "@/git/worktree";

/** A worktree step could not be done, with a reason worth putting in front of the reader. */
export class ArenaWorktreeError extends Error {}

async function runGit(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/**
 * That `repoPath` is a git work tree, or a loud refusal naming the path.
 *
 * The only claim the arena makes about a target repo before fanning contestants into worktrees
 * of it; a non-repository would otherwise fail one contestant at a time, mid-run, with git's
 * own stderr -- which names the worktree and not the decision that made it.
 */
export async function assertGitRepository(repoPath: string): Promise<void> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
  if (inside.code !== 0) {
    throw new ArenaWorktreeError(`"${repoPath}" is not a git repository: ${inside.err || inside.out}`);
  }
}

/**
 * Makes `path`, an empty folder, the new repository of a run that named none: `git init`, the
 * contestants' worktree folders kept out of its own status, and one empty commit for every
 * contestant to start at.
 *
 * The commit is the arena's, and is made the same way on every machine: its own author, no
 * signing, no hooks, so a machine's git identity or a global commit hook cannot stop a run.
 */
export async function initRunRepository(options: {
  path: string;
  message: string;
  worktreeFolders: readonly string[];
}): Promise<void> {
  const { path, message, worktreeFolders } = options;
  const init = await runGit(["init", "-q", "-b", "main"], path);
  if (init.code !== 0) throw new ArenaWorktreeError(`git init ${path} failed: ${init.err || init.out || init.code}`);
  // A git whose init template has no `info/` still reads the exclude file once it is there.
  await mkdir(join(path, ".git", "info"), { recursive: true });
  await appendFile(join(path, ".git", "info", "exclude"), worktreeFolders.map((folder) => `/${folder}/\n`).join(""));
  const commit = await runGit([
    "-c", "user.name=Agent Desk Arena",
    "-c", "user.email=arena@agentdesk.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "-q", "--allow-empty", "-m", message,
  ], path);
  if (commit.code !== 0) {
    throw new ArenaWorktreeError(`the first commit in ${path} failed: ${commit.err || commit.out || commit.code}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes one contestant's worktree: a detached checkout of `ref` at `path`.
 *
 * The path is the arena's own (`<arenaHome>/<run folder>/<contestantId>`, built by the service,
 * never read off a request), and it must not exist yet: a worktree appearing in a fresh run's
 * folder can only be a bug in that construction, and reusing whatever is there would hide it.
 */
export async function addContestantWorktree(options: {
  repoPath: string;
  path: string;
  ref: string;
}): Promise<void> {
  const { repoPath, path, ref } = options;
  if (await pathExists(path)) {
    throw new ArenaWorktreeError(`${path} already exists; a contestant worktree must be made new`);
  }
  const added = await runGit(["worktree", "add", "--detach", path, ref], repoPath);
  if (added.code !== 0) {
    throw new ArenaWorktreeError(
      `git worktree add ${path} at ${ref} failed: ${added.err || added.out || added.code}`,
    );
  }
}

/**
 * Removes one contestant's worktree, forced, after checking it is this arena's to remove.
 *
 * `--force` is deliberate and is the whole difference from a fork's removal: a contestant's
 * uncommitted work is its OUTPUT, captured into the run's diff before this runs, so the work is
 * not lost -- the record of it is what the arena keeps. The checks before it are the ones that
 * make forcing safe: the path must read as a worktree of exactly this run's repository, or the
 * refusal names it and nothing is removed at all.
 */
export async function removeContestantWorktree(options: {
  repoPath: string;
  path: string;
}): Promise<void> {
  const { repoPath, path } = options;
  const worktree = await readWorktree(path);
  const owner = await realpath(repoPath).catch(() => null);
  if (!worktree) throw new ArenaWorktreeError(`${path} is not a git worktree`);
  if (owner === null || worktree.mainCheckout !== owner) {
    throw new ArenaWorktreeError(`${path} is a worktree of ${worktree.mainCheckout}, not of ${repoPath}`);
  }
  const removed = await runGit(["worktree", "remove", "--force", path], repoPath);
  if (removed.code !== 0) {
    throw new ArenaWorktreeError(
      `git worktree remove ${path} failed: ${removed.err || removed.out || removed.code}`,
    );
  }
}

/** Drops worktree registrations the arena left behind, e.g. a directory deleted under git. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  const pruned = await runGit(["worktree", "prune"], repoPath);
  if (pruned.code !== 0) {
    throw new ArenaWorktreeError(`git worktree prune failed: ${pruned.err || pruned.out || pruned.code}`);
  }
}

/**
 * What a contestant did to its worktree, as `git diff <ref>` -- tracked changes only.
 *
 * Untracked files are deliberately not in it: a diff is bounded by what git tracks, and a
 * contestant's NEW files are still named where the arena records them, in `filesWritten`.
 * The caller caps the size; this returns the whole diff and refuses nothing.
 */
export async function captureWorktreeDiff(options: {
  worktreePath: string;
  ref: string;
}): Promise<string> {
  const { worktreePath, ref } = options;
  const diffed = await runGit(["diff", ref], worktreePath);
  if (diffed.code !== 0) {
    throw new ArenaWorktreeError(
      `git diff ${ref} in ${worktreePath} failed: ${diffed.err || diffed.out || diffed.code}`,
    );
  }
  return diffed.out;
}

/** These steps, as the arena service takes them; injected so its tests can fake git. */
export interface ArenaWorktreeSteps {
  assertRepository(repoPath: string): Promise<void>;
  initRepository(options: { path: string; message: string; worktreeFolders: readonly string[] }): Promise<void>;
  add(options: { repoPath: string; path: string; ref: string }): Promise<void>;
  remove(options: { repoPath: string; path: string }): Promise<void>;
  prune(repoPath: string): Promise<void>;
  captureDiff(options: { worktreePath: string; ref: string }): Promise<string>;
}

/**
 * Removes every contestant's worktree and prunes the registrations, best-effort and whole.
 *
 * Every removal is attempted even after one fails, then every failure is named in the log: a
 * teardown that stopped at the first refusal would leave the rest of a run's worktrees
 * registered against the repository, which is the half-torn-down state
 * `worktreeRemovalRefusal` refuses to let a caller reach. A worktree that was never made --
 * a run whose making failed halfway -- is refused by the same check as a stranger's, and the
 * rest still go.
 */
export async function undoWorktrees(
  steps: Pick<ArenaWorktreeSteps, "remove" | "prune">,
  repoPath: string,
  records: readonly { worktreePath: string }[],
): Promise<void> {
  const refused: string[] = [];
  for (const record of records) {
    try {
      await steps.remove({ repoPath, path: record.worktreePath });
    } catch (error) {
      refused.push(`${record.worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await steps.prune(repoPath);
  if (refused.length > 0) {
    console.error(
      `agent feed arena left worktrees in ${repoPath} (${refused.length}): ${refused.join("; ")}`,
    );
  }
}
