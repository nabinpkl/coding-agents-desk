// What git says about a workspace, for the tree's decorations and the source-control list.
//
// Ported from the host's `WorkspaceObservationCoordinator`, which produced the same
// `WorkspaceGitStatusResult` the sidebar rendered.
//
// This runs git itself rather than reusing the helper in `@/git/worktree`, and the reason is one
// character: that helper trims its output, and porcelain status lines begin with a significant
// space (` M file` is "modified in the worktree, unstaged"). Trimming would silently reclassify
// every unstaged change as a staged one.

import type { WorkspaceGitEntry, WorkspaceGitStatus } from "@agentdesk/agent-feed-wire";

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
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

/**
 * The status of one workspace, or an empty status when it is not a repository.
 *
 * Not being a repository is a normal state for a project root, not an error: the tree still draws,
 * the source-control section is simply empty. A git that fails for any other reason lands the same
 * way, which is the one place this file is deliberately quiet, because a decoration that cannot be
 * computed must not stop a file from opening.
 */
export async function gitStatus(workspaceId: string, root: string): Promise<WorkspaceGitStatus> {
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
  if (status.code !== 0) return { workspaceId, branch: null, entries: [] };
  return {
    workspaceId,
    branch: branch.code === 0 ? branch.out.trim() || null : null,
    entries: parsePorcelain(status.out),
  };
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
