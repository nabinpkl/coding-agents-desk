// What git says about a workspace, for the tree's decorations and the source-control list.
//
// Ported from the host's `WorkspaceObservationCoordinator`, which produced the same
// `WorkspaceGitStatusResult` the sidebar rendered.
//
// This runs git itself rather than reusing the helper in `@/git/worktree`, and the reason is one
// character: that helper trims its output, and porcelain status lines begin with a significant
// space (` M file` is "modified in the worktree, unstaged"). Trimming would silently reclassify
// every unstaged change as a staged one.

import { dirname, join } from "node:path";
import type { WorkspaceGitEntry, WorkspaceGitStatus } from "@agentdesk/agent-feed-wire";
import { literalPathspec, MAX_PATCH_BYTES } from "@/workspace/workspaceHistory";
import { WorkspaceFailure } from "@/workspace/workspacePaths";

/**
 * Runs git with optional locks off.
 *
 * `GIT_OPTIONAL_LOCKS=0` stops `git status` from refreshing and rewriting `.git/index` as a side
 * effect of reading it. Every read here is made because a watch reported a change, and a read
 * that writes the index is a change the same watch then reports: each refresh would schedule the
 * next one. VS Code's git extension sets the same variable for the same reason.
 */
async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [out, code] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return { code, out };
}

/** A porcelain status character, or null when it is a space, which means "nothing here". */
function statusCharacter(value: string | undefined): string | null {
  return value === undefined || value === " " ? null : value;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated rather than newline-separated because a path may contain a newline, and the
 * newline form escapes and quotes such a path instead, which would have to be unquoted here to get
 * back the bytes git already had. `-z` skips the round trip.
 *
 * A rename emits two records: `XY <new>\0<old>\0`. Only the new path is reported, because that is
 * the path the tree draws and the one a reader can open.
 */
export function parsePorcelain(output: string): WorkspaceGitEntry[] {
  const records = output.split("\0");
  const entries: WorkspaceGitEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = statusCharacter(record[0]);
    const workTreeStatus = statusCharacter(record[1]);
    entries.push({ relativePath: record.slice(3), indexStatus, workTreeStatus });
    // A rename or copy carries its source in the next record, which is not a status of its own.
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  return entries;
}

/** What git says about one directory: its branch and every path with something uncommitted. */
export interface DirectoryGitStatus {
  branch: string | null;
  entries: WorkspaceGitEntry[];
}

/**
 * The status of the repository a directory is in, or null when it is not in one.
 *
 * Null is kept apart from an empty status because the two read differently: a Bot's directory with
 * no repository has no changes to count at all, where a clean one has zero. A git that fails for
 * any other reason lands as null too, because a decoration that cannot be computed must not stop
 * anything else from drawing.
 */
export async function readGitStatus(root: string): Promise<DirectoryGitStatus | null> {
  const [status, branch] = await Promise.all([
    // `--untracked-files=all`, not the default `normal`: normal collapses a wholly untracked
    // directory to one `src/` record, so every file inside it would draw undecorated in a tree
    // that shows files. Ignored paths are excluded either way, so this expands only what a
    // reader could actually add.
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root),
    // `branch --show-current`, not `rev-parse --abbrev-ref HEAD`: on a repository with no
    // commits yet HEAD is unborn and rev-parse fails, so a fresh project would show no branch
    // at all. This answers the branch name either way.
    git(["branch", "--show-current"], root),
  ]);
  if (status.code !== 0) return null;
  return {
    branch: branch.code === 0 ? branch.out.trim() || null : null,
    entries: parsePorcelain(status.out),
  };
}

/**
 * The status of one workspace, or an empty status when it is not a repository.
 *
 * Not being a repository is a normal state for a project root, not an error: the tree still draws,
 * the source-control section is simply empty.
 */
export async function gitStatus(workspaceId: string, root: string): Promise<WorkspaceGitStatus> {
  const status = await readGitStatus(root);
  return { workspaceId, branch: status?.branch ?? null, entries: status?.entries ?? [] };
}

/** Where a directory's repository lives: its working tree's top, and its git directory. */
export interface RepositoryLocation {
  top: string;
  /** Absolute. Inside `top` for an ordinary clone, elsewhere for a linked worktree. */
  gitDir: string;
}

/** The repository a directory is in, or null when it is not in one. */
export async function repositoryLocation(directory: string): Promise<RepositoryLocation | null> {
  const answer = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], directory);
  if (answer.code !== 0) return null;
  const [top, gitDir] = answer.out.split("\n");
  return top && gitDir ? { top, gitDir } : null;
}

/** What `git status` could report on, by absolute path. See `listGitPaths`. */
export interface GitPaths {
  /** Every tracked file, and every untracked one git does not ignore. */
  files: Set<string>;
  /** Every directory holding one of them, and each one's ancestors up to `top`. */
  folders: Set<string>;
}

/**
 * The paths a change has to touch to move the status.
 *
 * Ancestors are included because a new directory appears as an entry in its parent, and a parent
 * holding only directories lists no file of its own. Measured 2026-09-25 on the Linux peer:
 * `rags` has 9,104 directories on disk and 37 in this set, listed in 5ms.
 */
export async function listGitPaths(top: string): Promise<GitPaths> {
  const answer = await git(["ls-files", "-co", "--exclude-standard", "-z"], top);
  const files = new Set<string>();
  const folders = new Set<string>([top]);
  if (answer.code !== 0) return { files, folders };
  for (const path of answer.out.split("\0")) {
    if (!path) continue;
    const file = join(top, path);
    files.add(file);
    for (let folder = dirname(file); folder.length > top.length; folder = dirname(folder)) {
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  }
  return { files, folders };
}

/** Whether git ignores a path that is not in the last `listGitPaths`. */
export async function isGitIgnored(top: string, path: string): Promise<boolean> {
  return (await git(["check-ignore", "-q", "--", path], top)).code === 0;
}

/** The tree of a repository with nothing in it, which is what an unborn `HEAD` is diffed against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The uncommitted change to one path, staged and unstaged together, against `HEAD`.
 *
 * Only a path `git status` reports is answered, which is both the confinement and the switch: the
 * path cannot name anything outside the changes, and an untracked file is the one case `git diff`
 * says nothing about, so it is diffed against nothing with `--no-index` to show it whole.
 *
 * Porcelain paths are relative to the repository's top, which may be above `root`, so the tracked
 * case uses the `:(top,literal)` pathspec and the untracked one joins onto the top itself.
 */
export async function workingTreeFileDiff(
  root: string,
  path: string,
): Promise<{ patch: string; truncated: boolean }> {
  const pathspec = literalPathspec(path);
  const status = await readGitStatus(root);
  const entry = status?.entries.find((candidate) => candidate.relativePath === path);
  if (!entry) throw new WorkspaceFailure("notFound");
  const plain = ["--no-color", "--no-ext-diff"];
  let answer: { code: number; out: string };
  if (entry.indexStatus === "?") {
    const top = await git(["rev-parse", "--show-toplevel"], root);
    if (top.code !== 0) throw new WorkspaceFailure("notFound");
    answer = await git(
      ["diff", "--no-index", ...plain, "--", "/dev/null", join(top.out.trim(), path)],
      root,
    );
    // `--no-index` exits 1 when the two sides differ, which against nothing they always do.
    if (answer.code === 1) answer = { ...answer, code: 0 };
  } else {
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root);
    answer = await git(
      ["diff", ...plain, head.code === 0 ? "HEAD" : EMPTY_TREE, "--", pathspec],
      root,
    );
  }
  if (answer.code !== 0) throw new WorkspaceFailure("notFound");
  const truncated = Buffer.byteLength(answer.out, "utf8") > MAX_PATCH_BYTES;
  return { patch: truncated ? answer.out.slice(0, MAX_PATCH_BYTES) : answer.out, truncated };
}

/**
 * The decoration for one tree path: its own status, or the status of something inside it.
 *
 * A directory wears the first status found beneath it, which is how a changed file deep in a
 * collapsed tree is still visible from the root. Matching on the `path + "/"` prefix rather than
 * on `startsWith(path)` so `src` does not claim `src-generated/`.
 */
export function statusForPath(
  entries: readonly WorkspaceGitEntry[],
  path: string,
): string | null {
  const prefix = `${path}/`;
  const entry = entries.find(
    (candidate) => candidate.relativePath === path || candidate.relativePath.startsWith(prefix),
  );
  if (!entry) return null;
  const combined = [entry.indexStatus, entry.workTreeStatus].filter(Boolean).join("");
  return combined === "" ? null : combined;
}
