// The history's reading position, kept outside the popup that draws it.
//
// The popup is unmounted every time it is dismissed -- Escape, or a pointer landing outside both
// the status bar and the editor. If the state lived in it, each of those would also throw away the
// log and the commit the reader had expanded, so coming back to a commit they were in the middle of
// would mean scrolling and re-expanding every time. It lives on the status bar instead, which never
// unmounts, and the popup is handed it.
//
// Nothing here is stored: which commit a reader had open is a position in a session, not an
// arrangement of the panel, and a popup that reopened three days later on a commit that has since
// been rebased away would be remembering the wrong thing (AGENTS.md, on what earns storage).

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceCommit, WorkspaceCommitDetail } from "@agentdesk/agent-feed-wire";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";

/** How many commits arrive at a time, and how many each "Show more" adds. */
export const PAGE = 50;

export interface CommitHistory {
  /** Null until the first answer, which is what the popup draws as "reading". */
  commits: WorkspaceCommit[] | null;
  failure: string | null;
  /** How many were asked for, so the popup knows whether there may be more. */
  limit: number;
  /** The one expanded commit, if any. One at a time: see the popup for why. */
  openHash: string | null;
  /** Its message and files, once they arrive. Cached by hash, so re-expanding is free. */
  details: Record<string, WorkspaceCommitDetail>;
  toggleCommit(hash: string): void;
  showMore(): void;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The log, and one commit's files.
 *
 * `enabled` is what keeps a reader who never opens the history from paying for it: the status bar
 * calls this on every render of every workspace, and the first fetch waits for the popup to have
 * been opened once.
 */
export function useCommitHistory(
  client: WorkspaceIdeClient,
  workspaceId: string | null,
  enabled: boolean,
): CommitHistory {
  const [limit, setLimit] = useState(PAGE);
  const [commits, setCommits] = useState<WorkspaceCommit[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, WorkspaceCommitDetail>>({});

  // A commit is a fact about one repository, so everything read here belongs to the workspace it
  // was read from. Switching projects with the caches left in place would draw the last project's
  // log under this project's branch.
  useEffect(() => {
    setCommits(null);
    setFailure(null);
    setOpenHash(null);
    setDetails({});
    setLimit(PAGE);
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || workspaceId === null) return;
    let live = true;
    client.commits(workspaceId, limit)
      .then((answer) => {
        if (live) setCommits(answer.commits);
      })
      .catch((cause: unknown) => {
        if (live) setFailure(`Could not read the history: ${message(cause)}`);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, limit, enabled]);

  useEffect(() => {
    if (openHash === null || workspaceId === null || details[openHash]) return;
    let live = true;
    client.commit(workspaceId, openHash)
      .then((answer) => {
        if (live) setDetails((current) => ({ ...current, [openHash]: answer.detail }));
      })
      .catch((cause: unknown) => {
        if (live) setFailure(`Could not read that commit: ${message(cause)}`);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, openHash, details]);

  return {
    commits,
    failure,
    limit,
    openHash,
    details,
    toggleCommit: useCallback(
      (hash: string) => setOpenHash((current) => (current === hash ? null : hash)),
      [],
    ),
    showMore: useCallback(() => setLimit((current) => current + PAGE), []),
  };
}
