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
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ArenaFolderCheck } from "@agentdesk/agent-feed-wire";
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
 * What a run would make of `path`: a repository it fans worktrees out of, a plain folder the reader
 * may have made one (`makeFolderRepository`), or a problem it refuses over (ADR-0153, ADR-0154).
 *
 * Read off the filesystem, not git, because the new-run form asks it of every project at once: a
 * folder is in a repository when it or a folder above it holds `.git` (a folder, or the file a
 * worktree or submodule keeps). A `.git` git cannot read still fails the run, at its first worktree,
 * with git's own reason.
 *
 * A plain folder is made a repository only inside `home`, the same root the folder browser is
 * confined to: a request names any path, and `git init` writes into the folder it names.
 */
export async function inspectArenaFolder(path: string, home: string = homedir()): Promise<ArenaFolderCheck> {
  const refused = (problem: string): ArenaFolderCheck => ({ path, repository: false, problem });
  if (!isAbsolute(path)) return refused("is not an absolute path");
  let resolved: string;
  try {
    resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) return refused("is not a folder");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // macOS keeps a few home folders (Downloads, Desktop, Documents) from a process it was not
    // asked to let in: that is not a folder that is missing.
    if (code === "ENOENT" || code === "ENOTDIR") return refused("does not exist");
    if (code === "EPERM" || code === "EACCES") return refused("cannot be read by the sidecar");
    return refused(`cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let folder = resolved; ; folder = dirname(folder)) {
    if (await pathExists(join(folder, ".git"))) return { path, repository: true, problem: null };
    if (dirname(folder) === folder) break;
  }
  const root = await realpath(home);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return refused("is not a git repository, and is outside the home folder, where a run makes none");
  }
  return { path, repository: false, problem: null };
}

/** A folder a reader asked to make a repository of, refused with the reason, which is theirs to fix. */
export class ArenaFolderRefusedError extends Error {}

/**
 * Makes a plain folder a repository, its files the first commit, on the reader's word: a run never
 * does this itself (ADR-0154). A folder already in one is answered as it is; one a run could not
 * use is refused naming why.
 */
export async function makeFolderRepository(
  steps: Pick<ArenaWorktreeSteps, "inspectFolder" | "initRepository">,
  path: string,
): Promise<ArenaFolderCheck> {
  const before = await steps.inspectFolder(path);
  if (before.problem) throw new ArenaFolderRefusedError(`"${path}" ${before.problem}`);
  if (before.repository) return before;
  await steps.initRepository({ path, message: "The folder as the arena found it", worktreeFolders: [] });
  return steps.inspectFolder(path);
}

/**
 * Makes `path` a repository: the run's own empty folder when it named none, or a plain folder the
 * reader asked for (ADR-0154). `git init`, the contestants' worktree folders kept out of its own
 * status, and one commit of whatever the folder holds -- nothing, for the run's own -- for every
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
  const added = await runGit(["add", "-A"], path);
  if (added.code !== 0)
    throw new ArenaWorktreeError(`git add in ${path} failed: ${added.err || added.out || added.code}`);
  const commit = await runGit(
    [
      "-c",
      "user.name=Agent Desk Arena",
      "-c",
      "user.email=arena@agentdesk.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    path,
  );
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
export async function addContestantWorktree(options: { repoPath: string; path: string; ref: string }): Promise<void> {
  const { repoPath, path, ref } = options;
  if (await pathExists(path)) {
    throw new ArenaWorktreeError(`${path} already exists; a contestant worktree must be made new`);
  }
  const added = await runGit(["worktree", "add", "--detach", path, ref], repoPath);
  if (added.code !== 0) {
    throw new ArenaWorktreeError(`git worktree add ${path} at ${ref} failed: ${added.err || added.out || added.code}`);
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
export async function removeContestantWorktree(options: { repoPath: string; path: string }): Promise<void> {
  const { repoPath, path } = options;
  const worktree = await readWorktree(path);
  const owner = await realpath(repoPath).catch(() => null);
  if (!worktree) throw new ArenaWorktreeError(`${path} is not a git worktree`);
  if (owner === null || worktree.mainCheckout !== owner) {
    throw new ArenaWorktreeError(`${path} is a worktree of ${worktree.mainCheckout}, not of ${repoPath}`);
  }
  const removed = await runGit(["worktree", "remove", "--force", path], repoPath);
  if (removed.code !== 0) {
    throw new ArenaWorktreeError(`git worktree remove ${path} failed: ${removed.err || removed.out || removed.code}`);
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
export async function captureWorktreeDiff(options: { worktreePath: string; ref: string }): Promise<string> {
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
  inspectFolder(path: string): Promise<ArenaFolderCheck>;
  initRepository(options: { path: string; message: string; worktreeFolders: readonly string[] }): Promise<void>;
  add(options: { repoPath: string; path: string; ref: string }): Promise<void>;
  remove(options: { repoPath: string; path: string }): Promise<void>;
  prune(repoPath: string): Promise<void>;
  captureDiff(options: { worktreePath: string; ref: string }): Promise<string>;
}

/** The steps over this machine's git. */
export const LIVE_WORKTREE_STEPS: ArenaWorktreeSteps = {
  inspectFolder: (path) => inspectArenaFolder(path),
  initRepository: initRunRepository,
  add: addContestantWorktree,
  remove: removeContestantWorktree,
  prune: pruneWorktrees,
  captureDiff: captureWorktreeDiff,
};

/** A diff longer than this is truncated with a marker, in memory and in its file alike. */
const MAXIMUM_DIFF_BYTES = 256 * 1024;

/** The diff as the arena keeps it: whole, or cut at the limit with a line saying so. */
export function boundedDiff(diff: string): string {
  return diff.length > MAXIMUM_DIFF_BYTES
    ? `${diff.slice(0, MAXIMUM_DIFF_BYTES)}\n… truncated at ${MAXIMUM_DIFF_BYTES} bytes\n`
    : diff;
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
    console.error(`agent feed arena left worktrees in ${repoPath} (${refused.length}): ${refused.join("; ")}`);
  }
}
