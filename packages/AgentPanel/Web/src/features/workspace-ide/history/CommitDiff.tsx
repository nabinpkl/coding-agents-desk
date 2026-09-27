// One file as a commit left it, in the editor: the tab, the patch, and the colours.
//
// The diff opens in the editor rather than inside the history popup, which is where it used to be
// drawn. A patch read in a 460px popup is read through a letterbox, and the reader has the whole
// editor sitting behind it -- the same place they would open the file itself, with the same tabs
// to get back to what they were doing. It is the shape every editor uses for this.
//
// Apart from the popup that lists the commits, because it is a different concern with a different
// reader: that is a list of what happened, and this is the text of one change. The drawing itself
// is `PatchView.tsx`, which takes a patch rather than a place in the history, so a Bot's
// uncommitted changes are drawn by the same rows.

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceCommit, WorkspaceCommitDiff, WorkspaceCommitFile } from "@agentdesk/agent-feed-wire";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { PatchView } from "@/features/workspace-ide/history/PatchView";

/** One file of one commit, which is what a diff tab is pointed at. */
export interface CommitDiffTarget {
  hash: string;
  shortHash: string;
  path: string;
  /** The commit's `--name-status` letter for it, which says whether there is still a file there. */
  status: string;
}

export interface CommitDiffTab {
  /** What the tab is showing, or null when there is no diff tab at all. */
  target: CommitDiffTarget | null;
  /** Whether the diff is the pane's content right now, as against a file tab being selected. */
  active: boolean;
  open(commit: WorkspaceCommit, file: WorkspaceCommitFile): void;
  /** Select the existing diff tab, which is what clicking it does. */
  show(): void;
  /** Leave the diff on its tab and show a file instead. */
  hide(): void;
  close(): void;
}

/**
 * The editor's one diff tab.
 *
 * One rather than a tab per commit: two diffs of the same file in different commits are told apart
 * only by seven characters of hash, so a strip of them is a row of near-identical tabs. Opening a
 * second diff replaces the first, and the file tabs beside it are untouched either way.
 *
 * Local state, not the workspace's shared state: what one reader is looking back at is not
 * something to push onto everybody else's screen, and the shared state stores paths, which a
 * commit and a path together are not.
 */
export function useCommitDiffTab(): CommitDiffTab {
  const [target, setTarget] = useState<CommitDiffTarget | null>(null);
  const [active, setActive] = useState(false);
  return {
    target,
    active: active && target !== null,
    open: useCallback((commit: WorkspaceCommit, file: WorkspaceCommitFile) => {
      setTarget({
        hash: commit.hash,
        shortHash: commit.shortHash,
        path: file.path,
        status: file.status,
      });
      setActive(true);
    }, []),
    show: useCallback(() => setActive(true), []),
    hide: useCallback(() => setActive(false), []),
    close: useCallback(() => {
      setTarget(null);
      setActive(false);
    }, []),
  };
}

/**
 * The patch for one file of one commit, fetched when the tab is pointed at it.
 *
 * The read happens here rather than in whatever opened the tab, so a tab that is reopened on the
 * same file re-reads rather than drawing a patch from before the branch moved.
 */
export function CommitDiffView({
  client,
  workspaceId,
  target,
}: {
  client: WorkspaceIdeClient;
  workspaceId: string;
  target: CommitDiffTarget;
}) {
  const [diff, setDiff] = useState<WorkspaceCommitDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { hash, path } = target;

  useEffect(() => {
    let live = true;
    setDiff(null);
    setFailure(null);
    client.commitDiff(workspaceId, hash, path)
      .then((answer) => {
        if (live) setDiff(answer.diff);
      })
      .catch((cause: unknown) => {
        if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, hash, path]);

  if (failure !== null) {
    return (
      <p role="status" className="m-0 p-6 text-center text-sm text-destructive">
        {failure}
      </p>
    );
  }
  if (diff === null) {
    return (
      <p className="m-0 flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Reading the diff…
      </p>
    );
  }
  return <PatchView diff={diff} />;
}
