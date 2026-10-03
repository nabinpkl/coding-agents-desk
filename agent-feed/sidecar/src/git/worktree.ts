// Answering "is this directory a worktree of that one", without running git.
//
// The question comes up because a session started in a `git worktree` is a session in a different
// directory, and every rule here that is keyed on a directory therefore refuses it: a Bot bound to
// a repository will not claim a session working in a worktree of that same repository, even though
// the two are the same project by every meaning a reader has.
//
// The link is already on disk and it is one line. A worktree's `.git` is a FILE rather than a
// directory, holding `gitdir: <checkout>/.git/worktrees/<name>`, and beside that pointer the main
// checkout keeps the worktree's `HEAD`. So both halves of the answer -- which checkout, and which
// branch -- are two small reads, and neither needs a subprocess.
//
// What must NOT be used is containment. Measured 2026-09-09 on this repository: one worktree sits
// at `.claude/worktrees/image-drop-indication`, INSIDE the checkout, and another at
// `../agent-desk-testflight-prev`, outside it. A path-prefix test links the first and misses the
// second, which is proximity standing in for ownership -- the mistake this repository already has
// a scar about. The `.git` file is the fact; where the directory sits is a coincidence.

import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/** A directory that is a linked worktree, and what it is linked to. */
export interface Worktree {
  /** The checkout it belongs to: the directory whose `.git` holds the real repository. */
  mainCheckout: string;
  /** The branch it has checked out, or null when its HEAD is detached. */
  branch: string | null;
}

const POINTER = "gitdir: ";
const LINK = "/.git/worktrees/";
/** A `.git` file is one short line. Anything larger is not the pointer this reads. */
const MAXIMUM_POINTER_BYTES = 4096;

/**
 * The worktree a directory is, or null when it is an ordinary checkout or not a repository at all.
 *
 * Null is deliberately the answer for all three of "not a repository", "the main checkout" and
 * "unreadable". Every caller wants the same thing from those cases -- treat the directory as
 * itself -- and distinguishing them would give callers a distinction none of them acts on.
 *
 * No cache and no subprocess: it is a stat and up to two small reads. `worktreeOf` below is the
 * one that remembers, because how long an answer stays true is the caller's question, not this
 * function's.
 */
export async function readWorktree(directory: string): Promise<Worktree | null> {
  let pointer: string;
  try {
    const path = join(directory, ".git");
    // A main checkout's `.git` is a directory, and reading it would throw EISDIR one line later.
    // Asking first keeps the ordinary case off the error path, since most directories are that.
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    if (metadata.size > MAXIMUM_POINTER_BYTES) return null;
    pointer = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const line = pointer.trim();
  if (!line.startsWith(POINTER)) return null;
  const gitDir = line.slice(POINTER.length).trim();
  // `<checkout>/.git/worktrees/<name>`. Split on the whole middle rather than counting segments,
  // because a checkout path may itself contain a directory called `worktrees`.
  const link = gitDir.lastIndexOf(LINK);
  if (link <= 0) return null;
  // Canonicalised, because the caller compares this against a path the catalog has already put
  // through `realpath` and git stores whatever path `worktree add` was given. Measured: a worktree
  // created under `/tmp` on macOS records `/private/tmp`, so the two agree there by luck rather
  // than by rule -- and the one case where they would not is a symlinked checkout, which is
  // exactly the case somebody sets up on purpose.
  const mainCheckout = await realpath(gitDir.slice(0, link)).catch(() => null);
  if (!mainCheckout) return null;
  const branch = await readBranch(gitDir);
  return { mainCheckout, branch };
}

/**
 * The branch a worktree has checked out, from the HEAD the main checkout keeps for it.
 *
 * Null covers a detached HEAD and an unreadable file alike, and for the same reason as above: a
 * caller showing a label has nothing different to say about the two.
 */
async function readBranch(gitDir: string): Promise<string | null> {
  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: refs/heads/")) return null;
    const branch = head.slice("ref: refs/heads/".length).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Whether a session working in `directory` is working in `checkout`, worktrees included.
 *
 * The predicate the directory-keyed rules want, in one place so they cannot drift apart. Attaching
 * a session to a Bot asks it of every directory the session has worked in
 * (`bots/sessions/botSessionHistory.ts`), and anything else deciding whether a session is a Bot's
 * should ask the same question rather than a near copy of it.
 */
export async function directoryBelongsTo(directory: string, checkout: string): Promise<boolean> {
  if (directory === checkout) return true;
  const worktree = await worktreeOf(directory);
  return worktree?.mainCheckout === checkout;
}

/**
 * Time an answer is reused before the disk is asked again.
 *
 * Short because the branch moves: a worktree can be switched under a running session, and a label
 * that is minutes stale names the wrong branch on a card somebody is about to commit from. Long
 * enough that one snapshot's worth of lookups -- every session on every Bot -- costs one read per
 * directory rather than one per session.
 */
const CACHE_MS = 5_000;

const cache = new Map<string, { at: number; value: Promise<Worktree | null> }>();

/** `readWorktree`, remembered briefly. */
export async function worktreeOf(directory: string): Promise<Worktree | null> {
  const now = Date.now();
  const held = cache.get(directory);
  if (held && now - held.at < CACHE_MS) return held.value;
  const value = readWorktree(directory);
  cache.set(directory, { at: now, value });
  // Bounded by the directories this machine has sessions in, which is small, but a process that
  // runs for weeks should not grow a map for every directory it has ever been asked about.
  if (cache.size > 256) {
    for (const [key, entry] of cache) {
      if (now - entry.at >= CACHE_MS) cache.delete(key);
    }
  }
  return value;
}

/** Forgets every remembered answer. For tests, which create and destroy worktrees in one run. */
export function forgetWorktrees(): void {
  cache.clear();
}

/** A worktree could not be prepared, with a reason worth putting in front of the reader. */
export class WorktreeError extends Error {}

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/**
 * Where this sidecar puts a worktree it makes.
 *
 * `.claude/worktrees/` because that is where the worktrees on this machine already are, and one
 * place to look beats a second convention that is only correct for whoever wrote it. It is inside
 * the checkout on purpose: a reader who wonders what branches are open finds them beside the
 * repository rather than having to remember a directory somewhere else.
 */
export function forkWorktreePath(checkout: string, branch: string): string {
  return join(checkout, ".claude", "worktrees", branch);
}

/**
 * A branch name from a session title, for a caller who named the fork and not the branch.
 *
 * Not clever: a reader who wants a particular branch says so. This exists so that the ordinary
 * fork -- named in a dialog, with nobody thinking about git -- lands somewhere recognisable
 * instead of on a uuid.
 */
export function branchFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "fork";
}

/**
 * Makes a worktree of `checkout` on `branch`, or returns the one that is already there.
 *
 * Idempotent because a terminal is opened more than once for one fork. The second open joins the
 * pane the first made rather than starting anything, and it runs through this on the way -- so
 * refusing an existing worktree would turn re-opening a fork into an error about a directory the
 * fork is happily running in.
 *
 * Refuses rather than reuses in the two cases where the directory or the branch belongs to someone
 * else. Several sessions share this repository, and quietly checking out a peer's branch into a
 * worktree they did not ask for is the kind of help nobody can undo.
 */
export async function prepareWorktree(options: {
  checkout: string;
  branch: string;
}): Promise<Worktree & { path: string }> {
  const { checkout, branch } = options;
  const valid = await git(["check-ref-format", "--branch", branch], checkout);
  if (valid.code !== 0) throw new WorktreeError(`"${branch}" is not a usable branch name`);

  const path = forkWorktreePath(checkout, branch);
  const existing = await readWorktree(path);
  if (existing) {
    if (existing.mainCheckout !== checkout) {
      throw new WorktreeError(`${path} is already a worktree of ${existing.mainCheckout}`);
    }
    if (existing.branch !== branch) {
      throw new WorktreeError(`${path} is already checked out at ${existing.branch ?? "a commit"}`);
    }
    return { ...existing, path };
  }
  if (await exists(path)) throw new WorktreeError(`${path} already exists and is not a worktree`);

  const branchExists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], checkout);
  if (branchExists.code === 0) {
    throw new WorktreeError(
      `branch "${branch}" already exists. Name the fork's branch explicitly to work on it.`,
    );
  }

  // Checked BEFORE creating, and refused rather than fixed. In this repository `git status` is how
  // sessions find out what their peers are doing, so a worktree directory that shows up there as
  // untracked is noise in the one signal that coordinates them -- and it is noise every session
  // sees, not just the one that made it. The line to add is named because the reader can add it
  // once and never think about this again.
  const ignored = await git(["check-ignore", "-q", path], checkout);
  if (ignored.code !== 0) {
    throw new WorktreeError(
      `${path} would show up in git status. Add ".claude/worktrees/" to .git/info/exclude first.`,
    );
  }

  const added = await git(["worktree", "add", "-b", branch, path], checkout);
  if (added.code !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.err || added.out || added.code}`);
  }
  forgetWorktrees();
  const created = await readWorktree(path);
  if (!created) throw new WorktreeError(`${path} was created but does not read as a worktree`);
  return { ...created, path };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why this directory cannot be removed as a worktree of `checkout`, or null when it can.
 *
 * Separate from the removal because a caller retiring several sessions must be able to ask about
 * all of them before it removes any: half a teardown is worse than none, and the refusals here are
 * exactly the ones worth discovering first. `removeWorktree` asks it again for itself, so a caller
 * that skips the check still cannot delete a directory that is not ours.
 */
export async function worktreeRemovalRefusal(options: {
  checkout: string;
  path: string;
}): Promise<string | null> {
  const { checkout, path } = options;
  // Said out loud even though `readWorktree` answers null for a main checkout anyway. This is the
  // one mistake in this file that would delete the repository rather than a directory beside it.
  if (path === checkout) return `${path} is the checkout itself, not a worktree of it`;
  const worktree = await readWorktree(path);
  if (!worktree) return `${path} is not a git worktree`;
  if (worktree.mainCheckout !== checkout) {
    return `${path} is a worktree of ${worktree.mainCheckout}, not of ${checkout}`;
  }
  const status = await git(["status", "--porcelain"], path);
  if (status.code !== 0) {
    return `git status in ${path} exited ${status.code}: ${status.err || status.out}`;
  }
  // Refused rather than forced, and this is the whole reason the check exists. `git worktree
  // remove --force` would take uncommitted work with it, and nothing anywhere can give that back.
  if (status.out !== "") return `${path} has uncommitted changes`;
  return null;
}

/**
 * Removes a worktree of `checkout`, and says which branch it had checked out.
 *
 * The branch comes back because the caller usually wants to delete it next and must not have to
 * name it: a caller that names a branch is a caller that can name someone else's.
 */
export async function removeWorktree(options: {
  checkout: string;
  path: string;
}): Promise<{ branch: string | null }> {
  const refusal = await worktreeRemovalRefusal(options);
  if (refusal) throw new WorktreeError(refusal);
  const branch = (await readWorktree(options.path))?.branch ?? null;
  // No `--force`: the check above said it is clean, and where git disagrees with that check git is
  // the one that is right.
  const removed = await git(["worktree", "remove", options.path], options.checkout);
  if (removed.code !== 0) {
    throw new WorktreeError(`git worktree remove failed: ${removed.err || removed.out || removed.code}`);
  }
  forgetWorktrees();
  return { branch };
}

/**
 * The remote a branch tracks, or null when it tracks none. It never guesses.
 *
 * Read BEFORE the branch is deleted, because `git branch -d` takes the branch's config section
 * with it and this answer lives there.
 *
 * Null rather than falling back to `origin`, and this is the difference between refusing and
 * destroying somebody's work. Measured 2026-09-09 in a throwaway repository: `git worktree add -b
 * <name>` leaves `branch.<name>.remote` UNSET, so a branch this sidecar made has no upstream at
 * all. Give that branch a name a remote is already using -- which is exactly what happens when a
 * worktree is remade after its remote branch outlived a hand-teardown -- and `origin` names a
 * DIFFERENT branch that shares nothing with it. `git branch -d` is no help there either: with no
 * upstream it compares against HEAD, so it passed on a fresh branch while the remote held commits
 * it had never looked at.
 *
 * So a caller that wants a remote branch deleted has to be able to show which one it is, and
 * tracking is the only evidence of that this repository can read.
 */
export async function branchRemote(options: {
  checkout: string;
  branch: string;
}): Promise<string | null> {
  const configured = await git(["config", `branch.${options.branch}.remote`], options.checkout);
  return configured.code === 0 && configured.out ? configured.out : null;
}

/**
 * Whether the checkout's HEAD already contains this branch.
 *
 * The question `git branch -d` does NOT answer once a branch has an upstream: it accepts a branch
 * merely because the branch is merged into its upstream, which means "these commits are safe on
 * the remote". That is a fine reason to delete a local branch and a terrible one to then delete
 * the remote copy, since the safety being relied on is the thing about to be removed. Asked
 * separately so that deleting both copies needs the commits to survive somewhere that is neither.
 */
export async function branchMergedIntoHead(options: {
  checkout: string;
  branch: string;
}): Promise<boolean> {
  const merged = await git(
    ["merge-base", "--is-ancestor", options.branch, "HEAD"],
    options.checkout,
  );
  return merged.code === 0;
}

/**
 * Deletes a local branch, letting git refuse one that is not merged.
 *
 * `-d`, never `-D`. Whether a branch is safe to lose is a question git already answers correctly
 * from the commit graph, and the version of this function that answers it here instead is the
 * version that loses somebody's commits.
 */
export async function deleteBranch(options: { checkout: string; branch: string }): Promise<void> {
  const deleted = await git(["branch", "-d", options.branch], options.checkout);
  if (deleted.code !== 0) {
    throw new WorktreeError(
      `git branch -d ${options.branch} failed: ${deleted.err || deleted.out || deleted.code}`,
    );
  }
}

/**
 * Deletes the branch on its remote.
 *
 * The one act in this file that reaches past this machine, which is why nothing here calls it
 * without being asked twice: the caller has already deleted the local branch, and git refusing
 * that is what stands in for "these commits are safe to lose".
 */
export async function deleteRemoteBranch(options: {
  checkout: string;
  branch: string;
  remote: string;
}): Promise<void> {
  const { checkout, branch, remote } = options;
  const known = await git(["remote", "get-url", remote], checkout);
  if (known.code !== 0) throw new WorktreeError(`no remote named "${remote}" to delete ${branch} from`);
  const deleted = await git(["push", remote, "--delete", branch], checkout);
  if (deleted.code !== 0) {
    throw new WorktreeError(
      `git push ${remote} --delete ${branch} failed: ${deleted.err || deleted.out || deleted.code}`,
    );
  }
}

/**
 * The remote-tracking ref for a branch, as `<remote>/<branch>`, or null when this clone has none.
 *
 * Local and offline on purpose: it reads what this clone last heard, not what the remote holds
 * now. That is the honest thing to report and the only thing that can be reported without a
 * network round trip inside a teardown, and a stale answer errs towards mentioning a branch that
 * is already gone rather than staying quiet about one that is not.
 */
export async function remoteTrackingRef(options: {
  checkout: string;
  remote: string;
  branch: string;
}): Promise<string | null> {
  const ref = `${options.remote}/${options.branch}`;
  const found = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`],
    options.checkout,
  );
  return found.code === 0 ? ref : null;
}
