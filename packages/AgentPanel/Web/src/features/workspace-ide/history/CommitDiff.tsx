// One file's change in the editor: the tab, the patch, and the colours. The change is either one
// commit's, opened from the history, or what is uncommitted, opened from the source-control list.
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

import { useCallback, useState } from "react";
import type { WorkspaceCommit, WorkspaceCommitFile } from "@agentdesk/agent-feed-wire";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { ReadPatchView } from "@/features/workspace-ide/history/PatchView";

/** One file of one commit, or one file's uncommitted change: what a diff tab is pointed at. */
export interface CommitDiffTarget {
  /** The commit whose change this is, or null for what is uncommitted against `HEAD`. */
  commit: { hash: string; shortHash: string } | null;
  path: string;
  /** Its status letter, which says whether there is still a file there: `D` means there is not. */
  status: string;
}

/** What the tab says it is showing beside the file's name: the commit, or that it is uncommitted. */
export function diffTargetLabel(target: CommitDiffTarget): string {
  return target.commit?.shortHash ?? "uncommitted";
}

export interface CommitDiffTab {
  /** What the tab is showing, or null when there is no diff tab at all. */
  target: CommitDiffTarget | null;
  /** Whether the diff is the pane's content right now, as against a file tab being selected. */
  active: boolean;
  open(commit: WorkspaceCommit, file: WorkspaceCommitFile): void;
  /** Point the tab at one path's uncommitted change, with its status letter. */
  openChange(path: string, status: string): void;
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
        commit: { hash: commit.hash, shortHash: commit.shortHash },
        path: file.path,
        status: file.status,
      });
      setActive(true);
    }, []),
    openChange: useCallback((path: string, status: string) => {
      setTarget({ commit: null, path, status });
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
 * The patch the tab is pointed at, fetched when it is pointed there.
 *
 * The read happens here rather than in whatever opened the tab, so a tab that is reopened on the
 * same file re-reads rather than drawing a patch from before the branch moved. An uncommitted
 * change is read again whenever git's status is, because the file may still be being written; a
 * commit's patch cannot move, so it is read once.
 */
export function CommitDiffView({
  client,
  workspaceId,
  target,
  gitRevision,
}: {
  client: WorkspaceIdeClient;
  workspaceId: string;
  target: CommitDiffTarget;
  /** Changes whenever git's status is read again. Only an uncommitted change listens to it. */
  gitRevision: unknown;
}) {
  const { path } = target;
  const hash = target.commit?.hash ?? null;
  return (
    <ReadPatchView
      subject={`${workspaceId}:${hash ?? "uncommitted"}:${path}`}
      refresh={hash === null ? gitRevision : null}
      read={() =>
        (hash === null
          ? client.changeDiff(workspaceId, path)
          : client.commitDiff(workspaceId, hash, path)
        ).then((answer) => answer.diff)}
    />
  );
}
