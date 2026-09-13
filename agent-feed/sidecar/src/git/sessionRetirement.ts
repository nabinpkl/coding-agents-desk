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
  branchRemote,
  deleteBranch,
  deleteRemoteBranch,
  readWorktree,
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
  worktree?: { path: string; branch: string | null; remote: string };
}

/** What the act actually did, and what it was asked for and could not do. */
export interface SessionRetirementOutcome {
  removedWorktree?: string;
  deletedBranch?: string;
  /** The remote the branch was deleted from, present only when it was. */
  deletedRemoteBranch?: string;
  failed: { step: "worktree" | "branch" | "remote"; reason: string }[];
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
  // Read while the branch still exists. `git branch -d` takes the branch's config section with it,
  // so a remote read afterwards answers `origin` for a branch that was never on `origin`.
  const remote = branch && disposals.remote === "delete"
    ? await branchRemote({ checkout, branch })
    : "";
  return { checkout, worktree: { path: projectPath, branch, remote } };
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
  const { path, branch, remote } = plan.worktree;

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
  if (disposals.remote !== "delete") return outcome;

  try {
    await deleteRemoteBranch({ checkout, branch, remote });
    outcome.deletedRemoteBranch = remote;
  } catch (error) {
    outcome.failed.push({ step: "remote", reason: reason(error) });
  }
  return outcome;
}

/** The steps that never got their turn, so `failed` answers for everything that was asked for. */
function blocked(
  disposals: SessionDisposals,
  outcome: SessionRetirementOutcome,
  because: string,
): void {
  if (disposals.branch === "delete") outcome.failed.push({ step: "branch", reason: because });
  if (disposals.remote === "delete") outcome.failed.push({ step: "remote", reason: because });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
