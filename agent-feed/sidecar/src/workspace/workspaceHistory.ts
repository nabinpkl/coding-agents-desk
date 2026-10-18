// What git has already recorded: the commits on this branch, what each one touched, and the patch
// for one of those paths.
//
// Separate from `workspaceGit.ts`, which answers what is uncommitted. The two read the same
// repository and nothing else: this one never touches the worktree, the index, or a ref, so every
// command here is a read and a bug in it cannot lose work.
//
// Every commit is read against its FIRST parent (`-m --first-parent`). A merge otherwise shows a
// combined diff, which is empty for a merge that took one side wholly -- the commonest merge there
// is -- so a reader expanding it would be told it changed nothing. First-parent answers the
// question the panel actually asks: what did this commit bring to the branch it is on.

import type {
  WorkspaceCommit,
  WorkspaceCommitDetail,
  WorkspaceCommitDiff,
  WorkspaceCommitFile,
} from "@agentdesk/agent-feed-wire";
import { pathComponents, WorkspaceFailure } from "@/workspace/workspacePaths";

/** The unit separator, between a log record's fields. Not in any hash, name or subject. */
const FIELD = "\u001f";

/** How many commits one request may ask for, however many it asks for. */
export const MAX_COMMITS = 500;

/**
 * The most patch bytes one file's diff may answer with.
 *
 * A generated file's rewrite is tens of megabytes of patch, and the panel draws every line of what
 * it is handed. The cut is reported rather than hidden: a diff that stops mid-hunk with nothing
 * said reads as the end of the change.
 */
export const MAX_PATCH_BYTES = 512 * 1024;

/** A hash as it comes back from git, and therefore the only shape a request may name. */
const HASH = /^[0-9a-f]{7,40}$/;

/**
 * The whole commit, in one argument list, for both the file list and a single file's patch.
 *
 * `--format=` empties the header so the output is diff and nothing else, which is what makes the
 * parsers below read the same shape for a root commit, an ordinary one, and a merge.
 */
const AGAINST_FIRST_PARENT = ["show", "--format=", "-m", "--first-parent"];

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  return { code, out };
}

/** Refuse anything that is not a hash before it reaches an argument list. */
function requireHash(hash: string): string {
  if (!HASH.test(hash)) throw new WorkspaceFailure("invalidPath");
  return hash;
}

/**
 * The pathspec for one file, with git's pattern language switched off.
 *
 * `:(top,literal)` matters twice: `literal` stops a filename containing `*`, `?` or `[` being read
 * as a glob that matches other files, and `top` roots it at the repository rather than at the cwd,
 * which is the workspace root and may be a subdirectory of the repository.
 */
export function literalPathspec(path: string): string {
  pathComponents(path, { allowRoot: false });
  return `:(top,literal)${path}`;
}

/**
 * Parse `git log -z --format=<fields>`.
 *
 * NUL between commits and a unit separator between fields, for the reason `parsePorcelain` uses
 * `-z`: a subject may contain anything a person can type, newlines included, and an escaped form
 * would have to be unescaped back into the bytes git already had. The subject is last so a
 * separator inside it -- which nothing produces, but nothing forbids either -- costs a subject
 * rather than the shape of the record.
 */
export function parseCommits(output: string): WorkspaceCommit[] {
  const commits: WorkspaceCommit[] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const fields = record.split(FIELD);
    if (fields.length < 6) continue;
    const [hash, shortHash, author, committed, parents] = fields as [string, string, string, string, string];
    commits.push({
      hash,
      shortHash,
      author,
      committedAt: Number.parseInt(committed, 10) || 0,
      parentCount: parents.trim() === "" ? 0 : parents.trim().split(" ").length,
      subject: fields.slice(5).join(FIELD),
    });
  }
  return commits;
}

/**
 * Parse `--name-status -z`: a status record, then the path, and a second path for a rename.
 *
 * The similarity score git appends to `R` and `C` (`R099`) is cut here rather than carried: it
 * answers "how alike were they", which no row asks, and leaving it on would make the status a
 * variable-width string that every reader of it has to trim.
 */
export function parseNameStatus(output: string): WorkspaceCommitFile[] {
  const records = output.split("\0");
  const files: WorkspaceCommitFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (!status) continue;
    const letter = status[0]!;
    const renamed = letter === "R" || letter === "C";
    const first = records[index + 1];
    if (first === undefined) break;
    if (renamed) {
      const second = records[index + 2];
      if (second === undefined) break;
      files.push({ path: second, status: letter, additions: null, deletions: null, previousPath: first });
      index += 2;
      continue;
    }
    files.push({ path: first, status: letter, additions: null, deletions: null, previousPath: null });
    index += 1;
  }
  return files;
}

/**
 * Parse `--numstat -z` into counts by path.
 *
 * Two record shapes, because a rename splits: an ordinary file is `<add>\t<del>\t<path>` in one
 * record, and a rename is `<add>\t<del>\t` with the old and new paths as the next two. A binary
 * file carries `-` for both counts, which stays null rather than becoming zero: zero is a claim
 * that nothing changed.
 */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, inlinePath] = parts as [string, string, string];
    const value = {
      additions: added === "-" ? null : Number.parseInt(added, 10),
      deletions: removed === "-" ? null : Number.parseInt(removed, 10),
    };
    if (inlinePath !== "") {
      counts.set(inlinePath, value);
      continue;
    }
    // The rename shape: the new path is the second of the two records that follow.
    const newPath = records[index + 2];
    if (newPath !== undefined) counts.set(newPath, value);
    index += 2;
  }
  return counts;
}

/**
 * The commits on the current branch, newest first.
 *
 * An empty list for a directory git does not track, or a repository with no commits yet, for the
 * same reason `gitStatus` answers an empty status: not being a repository is a normal state for a
 * project root, and the panel says so in words rather than showing a failure.
 */
export async function listCommits(root: string, limit: number): Promise<WorkspaceCommit[]> {
  const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_COMMITS);
  const { code, out } = await git(
    ["log", "-z", `--max-count=${count}`, `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ct${FIELD}%P${FIELD}%s`],
    root,
  );
  if (code !== 0) return [];
  return parseCommits(out);
}

/**
 * One commit: what its author wrote under the subject, and every path it touched with its counts.
 *
 * Three commands rather than one. Git will print several formats in one pass, but the joined
 * output then has to be split back apart on a boundary none of them marks. The name-status pass
 * owns the order and the status, the numstat pass is looked up by path -- so a path missing from
 * one of them costs its counts rather than the row -- and the message is its own read because it
 * is the one thing here that is not about files.
 *
 * The message is read with `-s` and no `-m`: a merge has one message however many parents it has,
 * and `-m` would print the header once per parent.
 */
export async function commitDetail(root: string, workspaceId: string, hash: string): Promise<WorkspaceCommitDetail> {
  const commit = requireHash(hash);
  const [message, names, numbers] = await Promise.all([
    git(["show", "-s", "--format=%b", commit], root),
    git([...AGAINST_FIRST_PARENT, "--name-status", "-z", commit], root),
    git([...AGAINST_FIRST_PARENT, "--numstat", "-z", commit], root),
  ]);
  if (names.code !== 0) throw new WorkspaceFailure("notFound");
  const counts = numbers.code === 0 ? parseNumstat(numbers.out) : new Map();
  return {
    workspaceId,
    hash,
    // Trimmed at the end only: the newlines after the last line are git's, and the blank lines
    // between paragraphs are the author's.
    body: message.code === 0 ? message.out.trimEnd() : "",
    files: parseNameStatus(names.out).map((file) => {
      const count = counts.get(file.path);
      return count ? { ...file, additions: count.additions, deletions: count.deletions } : file;
    }),
  };
}

/**
 * The patch for one path in one commit.
 *
 * `--no-color` and `--no-ext-diff` because this is read by a parser rather than by an eye: a
 * reader's `diff.external` or a colour setting in their global config would otherwise decide what
 * the panel is handed.
 */
export async function commitFileDiff(
  root: string,
  workspaceId: string,
  hash: string,
  path: string,
): Promise<WorkspaceCommitDiff> {
  const commit = requireHash(hash);
  const { code, out } = await git(
    [...AGAINST_FIRST_PARENT, "--no-color", "--no-ext-diff", commit, "--", literalPathspec(path)],
    root,
  );
  if (code !== 0) throw new WorkspaceFailure("notFound");
  const truncated = Buffer.byteLength(out, "utf8") > MAX_PATCH_BYTES;
  return {
    workspaceId,
    hash,
    path,
    // Sliced by characters after measuring bytes, so the cut never lands inside one: a byte slice
    // of UTF-8 can halve a character, and the panel would be handed a replacement glyph.
    patch: truncated ? out.slice(0, MAX_PATCH_BYTES) : out,
    truncated,
  };
}
