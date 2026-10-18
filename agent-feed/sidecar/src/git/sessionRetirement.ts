// Retiring a session's working tree: the worktree it ran in, the branch that worktree had checked
// out, and that branch's copy on the remote.
//
// Knows nothing about Bots on purpose. A Bot is one place a reader retires a session FROM, and a
// transcript view is another -- a reader decides to retire a session while looking at it, and a
// session nobody curated onto a Bot cannot be retired through a Bot at all. So the operation takes
// a checkout and a directory, and whoever calls it answers for whether the caller may.
//
// Split into a plan and an act because the two have opposite duties. The plan RAISES, while nothing
// has happened, so a caller retiring three sessions does not learn about the third one's
// uncommitted work with two panes already dead. The act REPORTS, because a step that fails after
// the plan passed is a fact about the world since, and refusing there would strand the steps behind
// it.

import {
  branchMergedIntoHead,
  branchRemote,
  deleteBranch,
  deleteRemoteBranch,
  readWorktree,
  remoteTrackingRef,
  removeWorktree,
  WorktreeError,
  worktreeRemovalRefusal,
} from "@/git/worktree";

/** What a caller wants disposed of. Every one of them defaults to keep at the edge. */
export interface SessionDisposals {
  worktree: "remove" | "keep";
  branch: "delete" | "keep";
  remote: "delete" | "keep";
}

/**
 * What one session's teardown will do, once every refusal has been ruled out.
 *
 * A value rather than state on anything, so two teardowns can be in flight without writing over
 * each other's answer, and so every git command in the act runs against the checkout the refusals
 * were checked against.
 */
export interface SessionRetirementPlan {
  checkout: string;
  worktree?: {
    path: string;
    branch: string | null;
    /** The remote to delete the branch from, empty when that was not asked for. */
    remote: string;
    /** The remote the branch tracks, read while the branch still has config to read. */
    tracked: string;
  };
}

/** What the act actually did, and what it was asked for and could not do. */
export interface SessionRetirementOutcome {
  removedWorktree?: string;
  deletedBranch?: string;
  /** The remote branch that was deleted, as `<remote>/<branch>`, present only when it was. */
  deletedRemoteBranch?: string;
  /**
   * A remote branch left behind by deleting the local one, as `<remote>/<branch>`.
   *
   * Reported rather than removed. Deleting the local branch is what makes the remote copy hard to
   * see: nothing local points at it any more, so it stops appearing in `git branch` and surfaces
   * only to somebody who runs `git ls-remote` or opens the branch list in a browser. It is still
   * somebody's to delete or keep, and this call is not entitled to decide that, so it says the
   * name and stops.
   */
  orphanedRemoteBranch?: string;
  failed: { step: "worktree" | "branch" | "remote"; reason: string }[];
}

/**
 * The disposal combinations that cannot mean what they say, or null when they can.
 *
 * Stated here rather than only at the HTTP edge, because this module is the reusable half and a
 * core that behaves only when some particular caller has already checked something is not
 * reusable. Without it, `remote: "delete"` with `branch: "keep"` plans cleanly, disposes nothing,
 * and reports an empty `failed` -- the caller asked for the remote to go, nothing went, and
 * nothing said so. The edge keeps its own copy of the question so a malformed request is still a
 * 400 rather than a conflict, but the sentence is written once and read from here.
 */
export function disposalRefusal(disposals: SessionDisposals): string | null {
  if (disposals.branch === "delete" && disposals.worktree !== "remove") {
    return 'branch: "delete" requires worktree: "remove"; git will not delete a branch a worktree has checked out';
  }
  if (disposals.remote === "delete" && disposals.branch !== "delete") {
    return 'remote: "delete" requires branch: "delete"; the checks that make a deletion safe are on the branch path, and keeping a local branch whose shared copy is gone is not a state this produces';
  }
  return null;
}

/**
 * Every refusal, raised before anything happens. Throws `WorktreeError`.
 *
 * `projectPath` is where the session was working. It is only needed when the worktree is being
 * removed, which is why a caller that cannot resolve it may still retire a session: ending a
 * session and forgetting it needs nothing from the disk.
 */
export async function planSessionRetirement(options: {
  checkout: string;
  projectPath?: string;
  disposals: SessionDisposals;
}): Promise<SessionRetirementPlan> {
  const { checkout, projectPath, disposals } = options;
  const impossible = disposalRefusal(disposals);
  if (impossible) throw new WorktreeError(impossible);
  if (disposals.worktree !== "remove") return { checkout };
  if (!projectPath) {
    throw new WorktreeError("the session's working directory is unknown, so its worktree cannot be removed");
  }
  const refusal = await worktreeRemovalRefusal({ checkout, path: projectPath });
  if (refusal) throw new WorktreeError(refusal);
  const branch = (await readWorktree(projectPath))?.branch ?? null;
  if (disposals.branch === "delete" && !branch) {
    throw new WorktreeError(`${projectPath} has a detached HEAD, so there is no branch to delete`);
  }
  return {
    checkout,
    worktree: {
      path: projectPath,
      branch,
      remote: await remoteToDelete(options, branch),
      // Read here for the same reason the delete's remote is: `git branch -d` takes the branch's
      // config with it, so after the act there is nothing left to ask.
      tracked: branch && disposals.branch === "delete" ? ((await branchRemote({ checkout, branch })) ?? "") : "",
    },
  };
}

/**
 * The remote branch to delete, once it has been shown to be safe to delete. Empty when not asked.
 *
 * Both questions are asked here, while the branch still exists, because `git branch -d` takes the
 * branch's config with it and because a refusal has to arrive before anything has been removed.
 *
 * Neither is a formality. Tracking is the only evidence this repository can read that the local
 * branch and the remote one of that name are the same branch; without it `origin/<name>` may be a
 * peer's unrelated work, and a branch made by `git worktree add -b` tracks nothing at all. And
 * being contained in HEAD is the check that `git branch -d` stops making the moment a branch has
 * an upstream: from then on it accepts "safe on the remote", which is not a reason to delete the
 * remote. Refuse rather than guess, and rather than delete on a guarantee that is about to be
 * removed.
 */
async function remoteToDelete(
  options: { checkout: string; disposals: SessionDisposals },
  branch: string | null,
): Promise<string> {
  const { checkout, disposals } = options;
  if (!branch || disposals.remote !== "delete") return "";
  const remote = await branchRemote({ checkout, branch });
  if (!remote) {
    throw new WorktreeError(
      `"${branch}" tracks no remote, so there is no remote branch this call can prove is the same one`,
    );
  }
  if (!(await branchMergedIntoHead({ checkout, branch }))) {
    throw new WorktreeError(
      `"${branch}" is not contained in HEAD, so deleting it on "${remote}" would remove the only copy`,
    );
  }
  return remote;
}

/**
 * The disk half. Reports rather than refuses, and never runs a step whose predecessor failed.
 *
 * The unmerged-branch case is the one worth knowing, because the ordering forces an asymmetry this
 * API cannot undo. A branch cannot be deleted while a worktree has it checked out, so the worktree
 * goes first; when `git branch -d` then refuses, the caller is left holding the branch with no
 * worktree. That is the right way round -- the branch is the work, the worktree is a directory --
 * but remaking that worktree today means a manual `git worktree add`, because `prepareWorktree`
 * refuses outright once the branch exists ("already exists. Name the fork's branch explicitly to
 * work on it") and refuses even when the caller DID name it explicitly, which is a promise that
 * message does not keep. Teaching it to adopt an existing branch is the follow-up that closes this.
 */
export async function disposeSessionWorktree(
  plan: SessionRetirementPlan,
  disposals: SessionDisposals,
): Promise<SessionRetirementOutcome> {
  const outcome: SessionRetirementOutcome = { failed: [] };
  if (!plan.worktree) return outcome;
  const { checkout } = plan;
  const { path, branch, remote, tracked } = plan.worktree;

  try {
    await removeWorktree({ checkout, path });
    outcome.removedWorktree = path;
  } catch (error) {
    outcome.failed.push({ step: "worktree", reason: reason(error) });
    // Nothing behind it can run: the branch is still checked out, so asking git to delete it would
    // only produce a second error saying exactly that.
    blocked(disposals, outcome, `${path} was not removed, so its branch is still checked out`);
    return outcome;
  }
  if (disposals.branch !== "delete" || !branch) return outcome;

  try {
    await deleteBranch({ checkout, branch });
    outcome.deletedBranch = branch;
  } catch (error) {
    outcome.failed.push({ step: "branch", reason: reason(error) });
    // The remote delete is deliberately NOT attempted. `git branch -d` refusing is the only
    // merged-ness check in this sequence, and running past it would leave the one step that
    // reaches other clones as the one with nothing in front of it.
    if (disposals.remote === "delete") {
      outcome.failed.push({ step: "remote", reason: `${branch} was not deleted locally` });
    }
    return outcome;
  }
  if (disposals.remote !== "delete") {
    // The branch is gone and its copy on the remote is not. Say so: this is the step a person
    // doing this by hand forgets, and the whole cost of forgetting it is that nothing mentions it
    // again.
    if (tracked) {
      const orphan = await remoteTrackingRef({ checkout, remote: tracked, branch });
      if (orphan) outcome.orphanedRemoteBranch = orphan;
    }
    return outcome;
  }

  try {
    await deleteRemoteBranch({ checkout, branch, remote });
    outcome.deletedRemoteBranch = `${remote}/${branch}`;
  } catch (error) {
    outcome.failed.push({ step: "remote", reason: reason(error) });
  }
  return outcome;
}

/** The steps that never got their turn, so `failed` answers for everything that was asked for. */
function blocked(disposals: SessionDisposals, outcome: SessionRetirementOutcome, because: string): void {
  if (disposals.branch === "delete") outcome.failed.push({ step: "branch", reason: because });
  if (disposals.remote === "delete") outcome.failed.push({ step: "remote", reason: because });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
