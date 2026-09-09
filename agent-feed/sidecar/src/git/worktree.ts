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
 * The predicate the directory-keyed rules want, in one place so they cannot drift apart. Two of
 * them exist in the Bot registry alone -- one deciding whether a session may be attached and one
 * deciding whether an attached session still resolves -- and a Bot that accepts a session it will
 * not then show would be worse than one that refuses it outright.
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
